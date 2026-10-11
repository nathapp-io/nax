// src/finish/a3-hints.ts
/**
 * A4: the A3 worth-check's skipped findings for one feature, as hints for the
 * branch reviewer (spec §4.4). Context only — never findings by themselves.
 *
 * Only `mode: "on"` records with a parsed reply count: in shadow mode the
 * worth-check judged but nothing was skipped, so its `skip` verdicts are not
 * "previously skipped". Every read failure degrades to fewer hints, never a throw.
 */
import { join } from "node:path";
import { getSafeLogger } from "@/logger";

export interface A3Hint {
  file?: string;
  line?: number;
  severity: string;
  message: string;
  reason: string;
}

async function listJson(dir: string): Promise<string[]> {
  const glob = new Bun.Glob("*.json");
  const out: string[] = [];
  for await (const name of glob.scan({ cwd: dir, absolute: false })) out.push(join(dir, name));
  return out.sort((a, b) => a.localeCompare(b));
}

export const _a3HintsDeps = {
  listJson,
  readText: (path: string): Promise<string> => Bun.file(path).text(),
};

interface AuditFinding {
  index?: unknown;
  severity?: unknown;
  file?: unknown;
  line?: unknown;
  message?: unknown;
}

function hintsFromRecord(raw: unknown): A3Hint[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as { mode?: unknown; parsed?: unknown; findings?: unknown; verdicts?: unknown };
  if (r.mode !== "on" || r.parsed !== true || !Array.isArray(r.findings) || !Array.isArray(r.verdicts)) return [];
  const findings = r.findings as AuditFinding[];
  const out: A3Hint[] = [];
  for (const v of r.verdicts as { index?: unknown; verdict?: unknown; reason?: unknown }[]) {
    if (v.verdict !== "skip" || typeof v.index !== "number") continue;
    const f = findings.find((x) => x.index === v.index);
    if (!f || typeof f.message !== "string") continue;
    out.push({
      ...(typeof f.file === "string" ? { file: f.file } : {}),
      ...(typeof f.line === "number" ? { line: f.line } : {}),
      severity: typeof f.severity === "string" ? f.severity : "info",
      message: f.message,
      reason: typeof v.reason === "string" ? v.reason : "",
    });
  }
  return out;
}

export async function readA3Hints(outputDir: string, feature: string): Promise<A3Hint[]> {
  const dir = join(outputDir, "nbf-worth-check", feature);
  let files: string[];
  try {
    files = await _a3HintsDeps.listJson(dir);
  } catch {
    return []; // no worth-check records for this feature: off, or never ran
  }
  const hints: A3Hint[] = [];
  for (const path of files) {
    try {
      hints.push(...hintsFromRecord(JSON.parse(await _a3HintsDeps.readText(path))));
    } catch (err) {
      getSafeLogger()?.debug("finish", "A3 hint record skipped", { storyId: "_run", path, error: String(err) });
    }
  }
  return hints;
}
