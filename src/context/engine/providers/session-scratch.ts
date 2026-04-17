/**
 * Context Engine v2 — SessionScratchProvider
 *
 * Reads session scratch entries from JSONL files written by pipeline stages
 * (verify, rectify) and surfaces them as "session" kind chunks.
 *
 * The provider is stateless: scratch dirs are passed via ContextRequest.storyScratchDirs.
 * Each dir is expected to contain a scratch.jsonl file; missing files return empty.
 *
 * Phase 1: reads verify-result and rectify-attempt entries.
 * Phase 2+: additional entry kinds (review findings, tool call results).
 * AC-42: neutralizes agent-specific tool references when entry.writtenByAgent
 *        differs from the target agent (request.agentId).
 *
 * See: docs/specs/SPEC-context-engine-v2.md §SessionScratchProvider
 */

import { createHash } from "node:crypto";
import type { ScratchEntry } from "../../../session/scratch-writer";
import { scratchFilePath } from "../../../session/scratch-writer";
import { neutralizeForAgent } from "../scratch-neutralizer";
import type { ContextProviderResult, ContextRequest, IContextProvider, RawChunk } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum number of entries to include per scratch dir (most recent N) */
const MAX_ENTRIES_PER_DIR = 20;

/** Approximate token budget ceiling per chunk (to avoid giant chunks) */
const MAX_CHUNK_TOKENS = 500;

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps
// ─────────────────────────────────────────────────────────────────────────────

export const _sessionScratchDeps = {
  fileExists: (path: string): Promise<boolean> => Bun.file(path).exists(),
  readFile: (path: string): Promise<string> => Bun.file(path).text(),
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function contentHash8(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

/** Parse a JSONL string into ScratchEntry objects, skipping malformed lines */
function parseJsonl(raw: string): ScratchEntry[] {
  const entries: ScratchEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as ScratchEntry);
    } catch {
      // Skip malformed lines — scratch may be partially written
    }
  }
  return entries;
}

/**
 * Render a ScratchEntry to human-readable Markdown for the push block.
 *
 * When entry.writtenByAgent is set and differs from targetAgentId, free-text
 * fields (outputTail) are passed through neutralizeForAgent() to strip
 * agent-specific tool-name references (AC-42).
 */
function renderEntry(entry: ScratchEntry, targetAgentId?: string): string {
  switch (entry.kind) {
    case "verify-result": {
      const status = entry.success ? "PASS" : `FAIL (${entry.failCount} failures)`;
      const lines = [`**Verify** at ${entry.timestamp}: ${status} — ${entry.passCount} pass / ${entry.failCount} fail`];
      if (!entry.success && entry.rawOutputTail) {
        lines.push("```", entry.rawOutputTail.trim(), "```");
      }
      return lines.join("\n");
    }
    case "rectify-attempt":
      return `**Rectify** attempt ${entry.attempt} at ${entry.timestamp}: ${entry.succeeded ? "succeeded" : "failed"}`;
    case "tdd-session": {
      const changed = entry.filesChanged.length > 0 ? ` — changed: ${entry.filesChanged.join(", ")}` : "";
      const lines = [
        `**TDD ${entry.role}** at ${entry.timestamp}: ${entry.success ? "succeeded" : "failed"}${changed}`,
      ];
      if (entry.outputTail.trim()) {
        const tail = neutralizeForAgent(entry.outputTail.trim(), entry.writtenByAgent ?? "", targetAgentId ?? "");
        lines.push("```", tail, "```");
      }
      return lines.join("\n");
    }
    default:
      return JSON.stringify(entry);
  }
}

/**
 * Read a scratch dir and produce a RawChunk for its most recent entries.
 * Returns null when the dir has no scratch file or the file is empty.
 */
async function readScratchDir(scratchDir: string, targetAgentId?: string): Promise<RawChunk | null> {
  const filePath = scratchFilePath(scratchDir);
  if (!(await _sessionScratchDeps.fileExists(filePath))) return null;

  const raw = await _sessionScratchDeps.readFile(filePath);
  const allEntries = parseJsonl(raw);
  if (allEntries.length === 0) return null;

  // Take most recent N entries (tail of the JSONL)
  const entries = allEntries.slice(-MAX_ENTRIES_PER_DIR);
  const content = entries.map((e) => renderEntry(e, targetAgentId)).join("\n\n");

  // Truncate content to the token ceiling so the reported token count
  // matches the actual content length. Without truncation the packing stage
  // would trust the capped number and silently overrun the context budget.
  const MAX_CONTENT_CHARS = MAX_CHUNK_TOKENS * 4;
  const truncated = content.length > MAX_CONTENT_CHARS ? content.slice(0, MAX_CONTENT_CHARS) : content;

  const hash = contentHash8(truncated);
  const tokens = Math.ceil(truncated.length / 4);

  return {
    id: `session-scratch:${hash}`,
    kind: "session",
    scope: "session",
    role: ["all"],
    content: truncated,
    tokens,
    rawScore: 0.9,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads session scratch JSONL from each dir in request.storyScratchDirs
 * and emits one chunk per non-empty dir.
 */
export class SessionScratchProvider implements IContextProvider {
  readonly id = "session-scratch";
  readonly kind = "session" as const;

  async fetch(request: ContextRequest): Promise<ContextProviderResult> {
    const dirs = request.storyScratchDirs;
    if (!dirs || dirs.length === 0) {
      return { chunks: [], pullTools: [] };
    }

    const chunks: RawChunk[] = [];
    for (const dir of dirs) {
      const chunk = await readScratchDir(dir, request.agentId);
      if (chunk) chunks.push(chunk);
    }

    return { chunks, pullTools: [] };
  }
}
