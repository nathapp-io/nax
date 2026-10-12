import type { Finding } from "./types";

/** A finding's stable identity across rounds: source, title and file (no message text). */
export function findingId(f: Finding): string {
  return `${f.source ?? "quality"}|${f.title}|${f.file ?? ""}`.toLowerCase();
}
