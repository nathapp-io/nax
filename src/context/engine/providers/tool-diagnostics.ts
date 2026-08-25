/**
 * Context Engine v2 — ToolDiagnosticsProvider (US-002)
 *
 * Reads authoritative `tool-diagnostics` scratch entries from the same
 * `scratch.jsonl` files written by US-001 lint/typecheck capture, and
 * surfaces them as `diagnostics` kind chunks at session scope.
 *
 * Failure handling (per spec):
 * - Provider source file absent (no scratch file): fetch() returns empty chunks.
 * - Provider source file malformed (unparseable JSONL line): skip the unreadable
 *   unit, return whatever parsed; never throws.
 *
 * Wire contract: pullTools is always empty (push-style provider, like
 * SessionScratchProvider). `query_scratch` is the pull-style sibling
 * (separate spec).
 *
 * See: docs/superpowers/specs/2026-08-15-context-engine-v22-providers-design.md
 */

import { createHash } from "node:crypto";
import type { ToolDiagnosticsScratchEntry } from "@/session";
import { scratchFilePath } from "@/session";
import { readJsonlTail } from "@/utils/jsonl-tail";
import { formatDiagnostic } from "../diagnostic-formatter";
import type { ContextProviderResult, ContextRequest, IContextProvider, RawChunk } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps
// ─────────────────────────────────────────────────────────────────────────────

export const _toolDiagnosticsDeps = {
  fileExists: (path: string): Promise<boolean> => Bun.file(path).exists(),
  // CTX-3: tail-read — only the most recent MAX_ENTRIES_PER_DIR entries are
  // ever rendered (see below).
  readFile: (path: string): Promise<string> => readJsonlTail(path),
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function contentHash8(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

// CTX-4: mirrors SessionScratchProvider's caps — without them a story that
// fails lint/typecheck repeatedly accumulates dozens of full diagnostic
// blocks into one chunk, crowding out the rest of the token budget.
const MAX_ENTRIES_PER_DIR = 20;
const MAX_CHUNK_TOKENS = 500;
const MAX_CHUNK_CHARS = MAX_CHUNK_TOKENS * 4;

/** Parse JSONL text into an array of tool-diagnostics entries, skipping malformed lines. */
function parseToolDiagnosticsJsonl(raw: string): ToolDiagnosticsScratchEntry[] {
  const entries: ToolDiagnosticsScratchEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { kind?: string };
      if (parsed?.kind === "tool-diagnostics") {
        entries.push(parsed as ToolDiagnosticsScratchEntry);
      }
    } catch {
      // Skip malformed lines — scratch may be partially written
    }
  }
  return entries;
}

/** Render a list of tool-diagnostics entries as a Markdown block. */
function renderEntries(entries: ToolDiagnosticsScratchEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    const diagnostics = Array.isArray(entry.diagnostics) ? entry.diagnostics : [];
    for (const d of diagnostics) {
      // Defensive: skip null / non-object elements so a malformed-but-valid-JSON
      // entry (e.g. `diagnostics: [null]`) cannot make formatDiagnostic throw.
      // The spec's "never throws" contract covers more than just bad JSONL lines.
      if (d === null || typeof d !== "object") continue;
      lines.push(formatDiagnostic(d));
    }
  }
  return lines.join("\n");
}

/**
 * Read a scratch dir and produce a RawChunk for its tool-diagnostics entries.
 * Returns null when the dir has no scratch file, the file is empty, contains
 * no tool-diagnostics entries, or becomes unreadable after the existence check.
 */
async function readDiagnosticsDir(scratchDir: string): Promise<RawChunk | null> {
  const filePath = scratchFilePath(scratchDir);
  if (!(await _toolDiagnosticsDeps.fileExists(filePath))) return null;

  let raw: string;
  try {
    raw = await _toolDiagnosticsDeps.readFile(filePath);
  } catch {
    // File vanished or became unreadable after exists() returned true (race).
    // Skip this dir rather than aborting fetch() — other scratch dirs may still
    // be readable. Mirrors the "never throws" contract for malformed JSONL.
    return null;
  }
  const parsedEntries = parseToolDiagnosticsJsonl(raw);
  if (parsedEntries.length === 0) return null;

  // Most-recent-N entries, matching SessionScratchProvider (CTX-4).
  const entries = parsedEntries.slice(-MAX_ENTRIES_PER_DIR);

  let content = renderEntries(entries);
  if (!content) return null;
  if (content.length > MAX_CHUNK_CHARS) content = content.slice(0, MAX_CHUNK_CHARS);

  const hash = contentHash8(content);
  const tokens = Math.ceil(content.length / 4);

  return {
    id: `tool-diagnostics:${hash}`,
    kind: "diagnostics",
    scope: "session",
    role: ["all"],
    content,
    tokens,
    rawScore: 0.95,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads tool-diagnostics entries from `request.storyScratchDirs` and emits
 * one chunk per scratch dir that contains at least one such entry.
 */
export class ToolDiagnosticsProvider implements IContextProvider {
  readonly id = "tool-diagnostics" as const;
  readonly kind = "diagnostics" as const;

  async fetch(request: ContextRequest): Promise<ContextProviderResult> {
    const dirs = request.storyScratchDirs;
    if (!dirs || dirs.length === 0) {
      return { chunks: [], pullTools: [] };
    }

    const chunks: RawChunk[] = [];
    for (const dir of dirs) {
      const chunk = await readDiagnosticsDir(dir);
      if (chunk) chunks.push(chunk);
    }

    return { chunks, pullTools: [] };
  }
}
