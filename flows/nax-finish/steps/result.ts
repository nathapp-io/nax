/**
 * Finish-audit artifacts.
 *
 * These live under nax's global per-project output directory —
 * `~/.nax/<project>/finish-audit/<feature>/` — alongside `prompt-audit/` and
 * `review-audit/`, not in the user's repo. Two reasons the repo was the wrong
 * home: the artifact describes a *run*, not the source tree, so committing it
 * and gitignoring it are both wrong answers; and a per-feature, per-run path
 * makes the history queryable across runs, which a single overwritten
 * `.nax/nax-finish-result.json` never was.
 *
 * The plugin supplies `auditDir` because it owns nax's path SSOT
 * (`src/runtime/paths.ts`), which this module may not import — `flows/` is
 * loaded by acpx, outside nax's own process. Absent, we fall back to a
 * repo-local directory so a hand-run `acpx flow run` still records something.
 *
 * Two files per run:
 * - `<runId>.jsonl`       — one line per fix round, appended as it happens
 * - `<runId>.result.json` — the terminal result the plugin reads back
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FinishInput, FinishResult, FinishRound } from "../types";

/** Used when the plugin supplied no run id (e.g. a hand-run `acpx flow run`). */
const FALLBACK_RUN_ID = "run";

type AuditTarget = Pick<FinishInput, "auditDir" | "workdir" | "feature" | "runId">;

export function resolveAuditDir(input: AuditTarget): string {
  return input.auditDir ?? join(input.workdir, ".nax", "finish-audit", input.feature);
}

export function resultPath(input: AuditTarget): string {
  return join(resolveAuditDir(input), `${input.runId || FALLBACK_RUN_ID}.result.json`);
}

export function roundsPath(input: AuditTarget): string {
  return join(resolveAuditDir(input), `${input.runId || FALLBACK_RUN_ID}.jsonl`);
}

export const _resultDeps: {
  writeText: (p: string, s: string) => Promise<void>;
  appendText: (p: string, s: string) => Promise<void>;
  readText: (p: string) => Promise<string | null>;
} = {
  // node:fs, not Bun.write — this module runs inside acpx's Node process, where
  // the `Bun` global does not exist (see the header of `../exec.ts`). The mkdir
  // is not redundant: Bun.write creates missing parent directories implicitly,
  // writeFile does not, and the audit directory now lives under `~/.nax/`,
  // where for a project's first run nothing on the path exists yet.
  writeText: async (p, s) => {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, s, "utf8");
  },
  appendText: async (p, s) => {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, s, { encoding: "utf8", flag: "a" });
  },
  readText: async (p) => {
    try {
      return await readFile(p, "utf8");
    } catch {
      return null;
    }
  },
};

/**
 * Append one fix round to the run's audit trail.
 *
 * Best-effort: an unwritable audit directory must not take the flow down
 * mid-loop. The round is a record of work already done — losing the record is
 * bad, losing the run that did the work is worse.
 */
export async function appendRound(input: AuditTarget, round: FinishRound): Promise<void> {
  try {
    await _resultDeps.appendText(roundsPath(input), `${JSON.stringify(round)}\n`);
  } catch {
    // Intentionally swallowed — see the doc comment above.
  }
}

/** Read back every round recorded for this run, so a terminal result can embed them. */
export async function readRounds(input: AuditTarget): Promise<FinishRound[]> {
  const raw = await _resultDeps.readText(roundsPath(input));
  if (!raw) return [];
  const rounds: FinishRound[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      rounds.push(JSON.parse(line) as FinishRound);
    } catch {
      // A torn final line (killed mid-write) must not lose the rounds before it.
    }
  }
  return rounds;
}

/**
 * Write the terminal result, embedding every round this run recorded.
 *
 * Rounds are attached on *every* status, not just `escalated`: a finish that
 * succeeded after four rounds is precisely the case worth auditing — it says
 * the run's own review gates missed four defects — and it was the one case
 * that previously recorded nothing at all.
 */
export async function writeResult(input: AuditTarget, result: FinishResult): Promise<void> {
  const rounds = await readRounds(input);
  const withRounds: FinishResult = rounds.length > 0 ? { ...result, rounds } : result;
  await _resultDeps.writeText(resultPath(input), `${JSON.stringify(withRounds, null, 2)}\n`);
}
