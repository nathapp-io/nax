/**
 * Finish A: an interrupted fix op returns its handoff turn's reply prefixed with
 * HANDOFF_MARKER; `parse` reads it here. A marked reply is always `interrupted`,
 * with a note only when the JSON is usable.
 */
import { tryParseLLMJson } from "@/utils/llm-json";
import type { HandoffNote } from "../types";

export const HANDOFF_MARKER = "<!-- nax-finish-handoff -->";
const STATUSES: ReadonlySet<string> = new Set(["done", "partial", "not-started"]);

function isEntry(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.index === "number" &&
    typeof e.status === "string" &&
    STATUSES.has(e.status) &&
    Array.isArray(e.files) &&
    e.files.every((f) => typeof f === "string") &&
    typeof e.remaining === "string"
  );
}

export function isHandoffNote(v: unknown): v is HandoffNote {
  if (typeof v !== "object" || v === null) return false;
  const findings = (v as { findings?: unknown }).findings;
  return Array.isArray(findings) && findings.every(isEntry);
}

export function parseHandoffReply(output: string): { interrupted: true; handoffNote?: HandoffNote } | null {
  if (!output.startsWith(HANDOFF_MARKER)) return null;
  const parsed = tryParseLLMJson<unknown>(output.slice(HANDOFF_MARKER.length));
  return isHandoffNote(parsed) ? { interrupted: true, handoffNote: parsed } : { interrupted: true };
}
