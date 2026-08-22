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
 * Three files, two per run plus one per feature:
 * - `<runId>.jsonl`       — one line per fix round, appended as it happens
 * - `<runId>.result.json` — the terminal result the caller reads back
 * - `last.json`           — the cross-run ledger (#1674 part 1): the most
 *   recent terminal result's `branch`/`headSha`/`status`, so a later run's
 *   entry check can tell "already finished this exact commit" from "there is
 *   new work". Not scoped by `runId` — unlike the two files above, it is
 *   meant to survive past the run that wrote it.
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

/** One feature's most recent terminal finish, keyed on the commit it finished at. */
export interface FinishLedgerEntry {
  branch: string;
  headSha: string;
  status: FinishResult["status"];
  prUrl?: string;
  runId: string;
  finishedAt: string;
}

/** `last.json` lives directly under the feature's audit dir — one entry per feature, not per run. */
export function ledgerPath(auditDir: string): string {
  return join(auditDir, "last.json");
}

/** The statuses a re-run at the same HEAD must not repeat (#1674 part 1). */
const LEDGER_TERMINAL_STATUSES: ReadonlySet<FinishResult["status"]> = new Set([
  "opened",
  "promoted",
  "already-ready",
  "escalated",
]);

/**
 * Update the ledger from a terminal result, if it qualifies.
 *
 * Fail-soft, like `appendRound` and unlike `writeResult` itself: a ledger
 * write failing must not turn a successful finish into a reported failure —
 * the worst outcome of losing it is that the *next* run re-does work it
 * didn't need to, which is exactly today's (pre-#1674) behaviour. Losing
 * `result.json` (what `writeResult` guards) is worse: it is the only durable
 * record that this run happened at all, so that path keeps throwing.
 *
 * Silently a no-op when `result` carries no `headSha`/`branch` (a preflight
 * `nothing-to-finish` never reaches this) or its status is not one of the
 * four the ledger cares about.
 *
 * CRITICAL (post-#1674 review): an `escalated` result whose `deliveryError`
 * is set must never reach the ledger, even though its `status` is in
 * `LEDGER_TERMINAL_STATUSES`. `deliveryError` means the human was never
 * actually paged — a forge outage, an undetected forge, a Telegram failure,
 * or a run the user Ctrl-C'd mid-delivery (`machine.ts`'s aborted branch,
 * which sets a synthetic `deliveryError` for exactly this reason). Ledgering
 * an undelivered escalation as done would make `checkLedger`'s entry check
 * (`context.ts`) silently skip every later run at the same HEAD, losing the
 * page forever — the one false-positive direction that check's own doc
 * comment says must never happen. This check is the belt to
 * `writeResult`'s `ledger: false` opt-out's braces: the pre-delivery write
 * (`doEscalate`'s `base`, before `ops.escalate` is even attempted) already
 * skips the ledger via that opt-out, but a *delivery-attempted* result with
 * `deliveryError` reaches this function through the normal `ledger: true`
 * default, so it needs its own guard here too.
 */
async function updateLedger(t: AuditTarget, result: FinishResult): Promise<void> {
  if (!result.headSha || !result.branch) return;
  if (!LEDGER_TERMINAL_STATUSES.has(result.status)) return;
  if (result.status === "escalated" && result.deliveryError) return;
  const entry: FinishLedgerEntry = {
    branch: result.branch,
    headSha: result.headSha,
    status: result.status,
    ...(result.url ? { prUrl: result.url } : {}),
    runId: t.runId,
    finishedAt: new Date().toISOString(),
  };
  try {
    await mkdir(t.auditDir, { recursive: true });
    await writeFile(ledgerPath(t.auditDir), `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  } catch {
    // Intentionally swallowed — see the doc comment above.
  }
}

/** Every ledger entry recorded, or `null` on anything short of a clean read — absent, unreadable, or malformed all fail OPEN (finish runs) rather than throwing. */
export async function readLedger(auditDir: string): Promise<FinishLedgerEntry | null> {
  let raw: string;
  try {
    raw = await readFile(ledgerPath(auditDir), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<FinishLedgerEntry>;
    if (typeof parsed.branch !== "string" || typeof parsed.headSha !== "string" || typeof parsed.status !== "string") {
      return null;
    }
    return parsed as FinishLedgerEntry;
  } catch {
    return null;
  }
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

export interface WriteResultOptions {
  /**
   * Set `false` to skip the ledger update for this write. Default `true`.
   *
   * Exists for `doEscalate`'s pre-delivery write (`machine.ts`, #1399): that
   * write happens BEFORE `ops.escalate` is even attempted, purely so a
   * killed process still leaves a `result.json` behind — at that point
   * nothing is known yet about whether the escalation will actually reach a
   * human, so ledgering it as a done `escalated` outcome would be a lie.
   * The `result.json` write itself is unaffected by this option; only the
   * ledger side-effect is skipped.
   */
  ledger?: boolean;
}

/** The terminal result, with every recorded round embedded, on every status. */
export async function writeResult(
  t: AuditTarget,
  result: FinishResult,
  options: WriteResultOptions = {},
): Promise<void> {
  const rounds = await readRounds(t);
  const withRounds: FinishResult = rounds.length > 0 ? { ...result, rounds } : result;
  await mkdir(t.auditDir, { recursive: true });
  await writeFile(resultPath(t), `${JSON.stringify(withRounds, null, 2)}\n`, "utf8");
  if (options.ledger === false) return;
  // The ledger update is best-effort (see `updateLedger`'s doc comment) and
  // deliberately does not receive `withRounds` — the ledger is a small,
  // per-feature pointer, not a copy of the full audit trail.
  await updateLedger(t, result);
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
