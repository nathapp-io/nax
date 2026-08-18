/**
 * Finish-audit trail: append-only round history plus the terminal result.
 *
 * Ported from `flows/nax-finish/steps/result.ts` (read-only reference, not
 * imported — `flows/` runs inside acpx's own Node process). Two differences
 * from that source:
 *
 * - The audit directory is supplied by the caller (`AuditTarget.auditDir`)
 *   rather than derived here. The caller resolves it from
 *   `runtime.outputDir` (nax's own path SSOT, `src/runtime/paths.ts`), which
 *   this module may not import — same reasoning the original had for not
 *   importing nax's paths module, just satisfied the other way around now
 *   that this code runs inside nax's own process instead of acpx's.
 * - `recordRound` is the only writer that may assign `FinishRound.attempt`
 *   (see below).
 *
 * `node:fs/promises`, not `Bun.write`, for the round-append path: `Bun.write`
 * has no append mode. `mkdir` before append stays required — the per-project
 * audit directory does not exist on a project's first run.
 *
 * Two files per run:
 * - `<runId>.jsonl`       — one line per fix round, appended as it happens
 * - `<runId>.result.json` — the terminal result the caller reads back
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FinishState } from "./state";
import type { FinishPhase, FinishResult, FinishRound } from "./types";

export interface AuditTarget {
  /** `<outputDir>/finish-audit/<feature>`, resolved by the caller from `runtime.outputDir`. */
  auditDir: string;
  runId: string;
}

export function roundsPath(t: AuditTarget): string {
  return join(t.auditDir, `${t.runId}.jsonl`);
}

export function resultPath(t: AuditTarget): string {
  return join(t.auditDir, `${t.runId}.result.json`);
}

/**
 * Append one round to the trail (I6).
 *
 * Best-effort: an unwritable audit directory must not take a finish down
 * mid-loop. The round records work already done — losing the record is bad,
 * losing the run that did the work is worse.
 */
export async function appendRound(t: AuditTarget, round: FinishRound): Promise<void> {
  try {
    await mkdir(t.auditDir, { recursive: true });
    await appendFile(roundsPath(t), `${JSON.stringify(round)}\n`, "utf8");
  } catch {
    // Intentionally swallowed — see the doc comment above.
  }
}

/** Every round recorded for this run. A torn final line is skipped, not thrown. */
export async function readRounds(t: AuditTarget): Promise<FinishRound[]> {
  let raw: string;
  try {
    raw = await readFile(roundsPath(t), "utf8");
  } catch {
    return [];
  }

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

/** The terminal result, with every recorded round embedded, on every status. */
export async function writeResult(t: AuditTarget, result: FinishResult): Promise<void> {
  const rounds = await readRounds(t);
  const withRounds: FinishResult = rounds.length > 0 ? { ...result, rounds } : result;
  await mkdir(t.auditDir, { recursive: true });
  await writeFile(resultPath(t), `${JSON.stringify(withRounds, null, 2)}\n`, "utf8");
}

/**
 * Record one round. The ONLY place `attempt` is assigned (D2.3).
 *
 * The caller cannot supply `attempt` — the parameter type omits it — so the
 * two-counters-into-one-field defect (F3) cannot be reintroduced by a new
 * call site: the flow this was ported from had `commit_<phase>` write its fix
 * count and `route_<phase>` write its review count into the same field, so a
 * real trail read 1, 1, 3, 4 and nothing downstream could order it. No other
 * module may call `appendRound` directly.
 */
export async function recordRound(
  t: AuditTarget,
  state: FinishState,
  phase: FinishPhase,
  round: Omit<FinishRound, "attempt">,
): Promise<void> {
  state.phases[phase].rounds += 1;
  const attempt = state.phases[phase].rounds;
  await appendRound(t, { ...round, attempt });
}
