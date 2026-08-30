/**
 * Context Engine v2 — query_scratch pull tool handler (US-005).
 *
 * Server-side handler for the query_scratch pull tool. Reads the scratch JSONL
 * files from `storyScratchDirs` (the same dirs SessionScratchProvider /
 * ToolDiagnosticsProvider read for the push block), parses every entry, applies
 * optional `kind` and `limit` filters, and returns a Markdown string with one
 * entry per block. Cross-agent reads neutralize Claude-specific tool references
 * (AC-42 / US-005 AC10).
 *
 * Failure handling is forgiving by design:
 * - missing scratch dir → no-entries message (the spec mandates no throw)
 * - no entry matches the `kind` filter → no-entries message
 * - empty JSONL after parsing → no-entries message
 *
 * Budget: consume() first; an exhausted budget throws PULL_TOOL_BUDGET_EXHAUSTED
 * before any I/O, so the existing pull-tool budget path is unchanged.
 *
 * See: docs/specs/SPEC-context-engine-v2.md §Pull tools
 */

import type { UserStory } from "@/prd";
import { type ScratchEntry, scratchFilePath } from "@/session";
import { formatDiagnostic } from "../diagnostic-formatter";
import type { PullToolBudget } from "../pull-tools";
// STYLE-6 fix: pull-tools.ts no longer re-exports handleQueryScratch, but
// the dep-injection seam (`_pullToolsDeps`) and the token-budget constant
// (`DEFAULT_MAX_TOKENS_PER_CALL`) still live there — those references are
// one-way (`handlers → pull-tools`), not cyclical. `scratchFilePath` is
// imported from its true home (`@/session`) for symmetry with
// `tool-diagnostics.ts` (which already imports it that way).
import { _pullToolsDeps, DEFAULT_MAX_TOKENS_PER_CALL } from "../pull-tools";
import { fitScratchBlocks } from "../render-utils";
import { neutralizeForAgent } from "../scratch-neutralizer";

/**
 * Options for the query_scratch handler. `targetAgent` is the agent that
 * invoked query_scratch (the requesting/reading agent). The writer is read
 * per-entry from `entry.writtenByAgent`, mirroring SessionScratchProvider, so
 * cross-agent neutralization (AC-42) substitutes agent-specific tool
 * references when the requesting agent differs from the writer. Defaults to
 * the story's id when the runtime didn't pass it — covers same-agent reads
 * (no neutralization needed) and direct tests.
 */
export interface QueryScratchOptions {
  targetAgent?: string;
}

/**
 * Read a scratch directory's JSONL scratch file and return its parsed entries.
 * Returns an empty array when the file is absent or empty. Malformed lines
 * are silently skipped (parity with SessionScratchProvider).
 */
async function readScratchEntries(scratchDir: string): Promise<ScratchEntry[]> {
  const filePath = scratchFilePath(scratchDir);
  if (!(await _pullToolsDeps.fileExists(filePath))) return [];
  let raw: string;
  try {
    raw = await _pullToolsDeps.readFile(filePath);
  } catch {
    // File disappeared or became unreadable between the existence check and the
    // read — treat as absent (the spec mandates a no-entries response, not a throw).
    return [];
  }
  const entries: ScratchEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      // Skip non-object values (null, primitives, arrays) and objects without a
      // string `kind` — they cannot be rendered and must not abort the query.
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      if (typeof (parsed as { kind?: unknown }).kind !== "string") continue;
      entries.push(parsed as ScratchEntry);
    } catch {
      // Skip malformed lines — scratch may be partially written
    }
  }
  return entries;
}

/**
 * Render a single scratch entry to a one-line-ish Markdown fragment.
 * Mirrors SessionScratchProvider.renderEntry closely so the agent sees the
 * same shape pull-side as push-side. Free-text fields pass through
 * neutralizeForAgent() using the entry's own `writtenByAgent` as the writer,
 * so cross-agent reads see neutralized tool references.
 */
function renderScratchEntry(entry: ScratchEntry, targetAgent: string): string {
  switch (entry.kind) {
    case "verify-result": {
      const status = entry.success ? "PASS" : `FAIL (${entry.failCount} failures)`;
      const lines = [`**Verify** at ${entry.timestamp}: ${status} — ${entry.passCount} pass / ${entry.failCount} fail`];
      if (!entry.success && entry.rawOutputTail) {
        const tail = neutralizeForAgent(entry.rawOutputTail.trim(), entry.writtenByAgent ?? "", targetAgent);
        lines.push("```", tail, "```");
      }
      return lines.join("\n");
    }
    case "tdd-session": {
      const lines = [
        `**TDD ${entry.role}** at ${entry.timestamp}: ${entry.success ? "succeeded" : "failed"}${
          entry.filesChanged.length > 0 ? ` — changed: ${entry.filesChanged.join(", ")}` : ""
        }`,
      ];
      if (entry.outputTail.trim()) {
        const tail = neutralizeForAgent(entry.outputTail.trim(), entry.writtenByAgent ?? "", targetAgent);
        lines.push("```", tail, "```");
      }
      if (entry.selfVerification) {
        lines.push(
          `Self-verify: lint=${entry.selfVerification.lint}, typecheck=${entry.selfVerification.typecheck}, pre_existing=${entry.selfVerification.preExistingFailures.length}`,
        );
      }
      return lines.join("\n");
    }
    case "self-verification":
      return `**Self-verify** at ${entry.timestamp}: lint=${entry.selfVerification.lint}, typecheck=${entry.selfVerification.typecheck}, pre_existing=${entry.selfVerification.preExistingFailures.length}`;
    case "tool-diagnostics": {
      const lines = [`**Tool-diagnostics** at ${entry.timestamp}:`];
      for (const d of entry.diagnostics) {
        if (d === null || typeof d !== "object") continue;
        // ENH-5 fix: render via the shared formatDiagnostic helper so the
        // push path (ToolDiagnosticsProvider) and the pull path produce
        // byte-identical output for the same input.
        lines.push(formatDiagnostic(d));
      }
      return lines.join("\n");
    }
    default:
      return JSON.stringify(entry);
  }
}

/**
 * Server-side handler for the query_scratch pull tool.
 *
 * @param input            - Tool call arguments (optional kind, limit)
 * @param story            - Current user story (only story.id is used)
 * @param storyScratchDirs - Absolute paths to the story's scratch directories
 * @param budget           - Budget tracker for this session
 * @param maxTokensPerCall - Per-call token ceiling (chars = tokens × 4)
 * @param options          - Cross-agent neutralization options (AC-42)
 */
export async function handleQueryScratch(
  // Agent-authored JSON — see the note in query-feature-context.ts.
  input: { kind?: unknown; limit?: unknown },
  story: UserStory,
  storyScratchDirs: string[],
  budget: PullToolBudget,
  maxTokensPerCall: number = DEFAULT_MAX_TOKENS_PER_CALL,
  options: QueryScratchOptions = {},
): Promise<string> {
  budget.consume();

  const targetAgent = options.targetAgent ?? story.id;

  // Read every scratch dir; union the entries. Mirrors SessionScratchProvider's
  // and ToolDiagnosticsProvider's read pattern so push and pull see the same data.
  const allEntries: ScratchEntry[] = [];
  for (const dir of storyScratchDirs) {
    const entries = await readScratchEntries(dir);
    allEntries.push(...entries);
  }

  // Apply kind filter (AC6).
  const kind = typeof input.kind === "string" && input.kind !== "" ? input.kind : undefined;
  const limit = typeof input.limit === "number" && input.limit > 0 ? input.limit : undefined;
  const filtered = kind ? allEntries.filter((e) => e.kind === kind) : allEntries;

  // Apply limit (AC7). Most-recent-first: sort by timestamp descending, then
  // cap. JSONL appends write entries oldest-first at the tail, so the latest
  // entry is the last parsed line — reversing gives "most-recent first".
  const sortedNewestFirst = limit !== undefined;
  const limited = sortedNewestFirst
    ? [...filtered].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)).slice(0, limit)
    : filtered;

  // Render defensively: a malformed entry (e.g. a known kind missing a required
  // field) must not abort the whole query — skip it and continue.
  const rendered: string[] = [];
  for (const entry of limited) {
    try {
      rendered.push(renderScratchEntry(entry, targetAgent));
    } catch {
      // Skip malformed entries — scratch may be partially written
    }
  }

  // nax#1757: fit by dropping whole entries from the oldest end. `limited` is
  // most-recent-FIRST only when a `limit` was supplied and sorted above; with
  // no limit — the default call — it is JSONL order, oldest-first, where the
  // previous `slice(0, maxChars)` kept the oldest entries and dropped the
  // newest. Display order is unchanged in both branches.
  const maxChars = maxTokensPerCall * 4;
  const finalContent = fitScratchBlocks(rendered, maxChars, sortedNewestFirst);

  budget.record({
    tool: "query_scratch",
    query: kind ?? "",
    at: new Date().toISOString(),
    tokensReturned: Math.ceil(finalContent.length / 4),
    chunkIds: [],
  });

  const logger = _pullToolsDeps.getLogger();
  logger.info("pull-tool", "invoked", {
    storyId: story.id,
    tool: "query_scratch",
    kind: kind ?? null,
    limit: limit ?? null,
    resultCount: rendered.length,
    resultBytes: finalContent.length,
  });

  return rendered.length === 0 ? "No matching scratch entries." : finalContent;
}
