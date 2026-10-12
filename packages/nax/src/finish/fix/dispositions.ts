import { stat } from "node:fs/promises";
import path from "node:path";
import type { FindingDisposition } from "../types";

const DISPOSITION = /^\s*\[?(\d+)\]?\s*[.:)]?\s*(fixed|rejected)\b\s*(.*)$/i;
const EVIDENCE = /evidence\s*:\s*(ruling\s+D-\d+|\S+)/i;
const RULING_EVIDENCE = /^ruling\s+(D-\d+)$/;

/** Parse the `## DISPOSITIONS` section of a fix node's reply. */
export function parseDispositions(text: string): FindingDisposition[] {
  const out: FindingDisposition[] = [];
  for (const line of text.split("\n")) {
    const m = DISPOSITION.exec(line);
    if (!m) continue;
    const evidence = EVIDENCE.exec(m[3])?.[1];
    out.push({
      index: Number(m[1]),
      disposition: m[2].toLowerCase() as "fixed" | "rejected",
      ...(evidence ? { evidence } : {}),
    });
  }
  return out;
}

/**
 * Whether `rel` resolves to a real path inside `workdir`. `node:fs/promises`'s
 * `stat` is deliberate (`Bun.file("/tmp").exists()` is false for directories),
 * and the resolved path is confined under `workdir` so `../` cannot escape.
 */
async function exists(workdir: string, rel: string): Promise<boolean> {
  const root = path.resolve(workdir);
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return false;
  try {
    await stat(resolved);
    return true;
  } catch {
    return false;
  }
}

/** Mark any rejection whose cited `file:line` does not resolve in the repo, or whose cited ruling was not shown. */
export async function validateDispositions(
  workdir: string,
  dispositions: FindingDisposition[],
  rulingIds: readonly string[] = [],
): Promise<FindingDisposition[]> {
  return Promise.all(
    dispositions.map(async (d) => {
      if (d.disposition !== "rejected" || !d.evidence) return d;
      const ruling = RULING_EVIDENCE.exec(d.evidence.trim());
      if (ruling) return rulingIds.includes(ruling[1] ?? "") ? d : { ...d, evidenceMissing: true };
      const file = d.evidence.split(":")[0];
      return (await exists(workdir, file)) ? d : { ...d, evidenceMissing: true };
    }),
  );
}
