/** Detect and repair agent damage to nax run state (#2497). Never throws. */
import { constants } from "node:fs";
import { appendFile, type FileHandle, mkdir, open, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errorMessage, NaxError, withFileLock } from "@nathapp/nax-agent/internal";
import { getSafeLogger } from "../logger";
import { clearNaxIndexFlags, hiddenNaxPaths, type IndexFlagLogger } from "../utils/nax-index-flags";
import { holdsHandoffLock } from "../workflow/handoff-lock-owner";
import { handoffLockPath } from "../workflow/paths";
import {
  RESULT_RECOVERY_FILE,
  type ResultRecovery,
  restorePendingResults,
  writeResultRecovery,
} from "../workflow/result-recovery";
import { activeKeepers, type KeptFile, type RunStateKeeper, runStateWrite, withPathLock } from "./store";

export type RepairTrigger = "turn" | "pre-commit" | "run-end" | "crash";
export interface RepairContext {
  readonly trigger: RepairTrigger;
  readonly storyId?: string;
  readonly sessionName?: string;
  readonly stage?: string;
  readonly turn?: number;
  /** The workdir the #2490 flag sweep runs on: at run-end/crash always, otherwise only when no keeper is active. */
  readonly workdir?: string;
}
export type Damage = "missing" | "modified" | "hidden";
export interface RepairRecord {
  readonly path: string;
  readonly rel: string;
  readonly damage: readonly Damage[];
  readonly restored: boolean;
}

export const _repairDeps = {
  hiddenNaxPaths,
  clearNaxIndexFlags,
  logger: (): IndexFlagLogger | null => getSafeLogger() ?? null,
  readResultBytes,
};

/** The result as one read saw it: what the repair judged, and what a deferral records. */
interface ResultObservation {
  /** The raw bytes that read returned, or undefined when there was no file to read. */
  readonly bytes: Uint8Array | undefined;
}

/** Lock failures a repair may hand to the next lock-taker instead of failing: nothing was read or written. */
const DEFERRABLE_LOCK_CODES: ReadonlySet<string> = new Set(["FILE_LOCK_TIMEOUT", "FILE_LOCK_CLAIM_ORPHANED"]);
/** The triggers with no keeper left to retry: run end and crash are the last chance to keep the good copy. */
const DEFERRING_TRIGGERS: ReadonlySet<RepairTrigger> = new Set<RepairTrigger>(["run-end", "crash"]);

async function damageOf(f: KeptFile, hidden: ReadonlySet<string>): Promise<Damage[]> {
  const file = Bun.file(f.path);
  const exists = await file.exists();
  const content = exists ? await file.text() : undefined;
  return [
    ...(!exists ? (["missing"] as const) : []),
    ...(exists && content !== f.content ? (["modified"] as const) : []),
    ...(hidden.has(f.rel) ? (["hidden"] as const) : []),
  ];
}

async function restore(f: KeptFile): Promise<void> {
  await mkdir(dirname(f.path), { recursive: true });
  const tmp = `${f.path}.runstate-${crypto.randomUUID()}`;
  await Bun.write(tmp, f.content);
  await rename(tmp, f.path);
}

function where(ctx: RepairContext): string {
  return [ctx.storyId ?? "_run", ctx.stage, ctx.turn !== undefined ? `turn ${ctx.turn}` : ctx.trigger]
    .filter((p): p is string => p !== undefined)
    .join(" ");
}

async function repairFile(
  f: KeptFile,
  damage: Damage[],
  ctx: RepairContext,
  cleared: ReadonlySet<string>,
): Promise<RepairRecord> {
  try {
    if (needsRestore(damage)) await restore(f);
  } catch (error) {
    return failedRestore(f, damage, ctx, error);
  }
  const restored = !damage.includes("hidden") || cleared.has(f.rel);
  const log = _repairDeps.logger();
  const data = repairLogData(f, damage, ctx);
  if (restored) log?.warn("runstate", `${where(ctx)}: ${f.rel} ${damage.join("+")} by the agent; restored`, data);
  else log?.warn("runstate", `[FAIL] ${where(ctx)}: could not clear the index flag on ${f.rel}`, data);
  return { path: f.path, rel: f.rel, damage, restored };
}

function needsRestore(damage: readonly Damage[]): boolean {
  return damage.includes("missing") || damage.includes("modified");
}

function repairLogData(f: KeptFile, damage: Damage[], ctx: RepairContext) {
  return {
    storyId: ctx.storyId ?? "_run",
    sessionName: ctx.sessionName,
    stage: ctx.stage,
    turn: ctx.turn,
    trigger: ctx.trigger,
    path: f.rel,
    damage,
  };
}

function failedRestore(f: KeptFile, damage: Damage[], ctx: RepairContext, error: unknown): RepairRecord {
  _repairDeps.logger()?.warn("runstate", `[FAIL] ${where(ctx)}: could not restore ${f.rel}`, {
    ...repairLogData(f, damage, ctx),
    error: errorMessage(error),
  });
  return { path: f.path, rel: f.rel, damage, restored: false };
}

/** Whether the lock failure may be handed to the next holder: a lock this repair could not take, at a
 *  trigger with no keeper left to retry. Everything else — a known-invalid lock file, an unwritable
 *  directory, a failing write — keeps the failure path it has always had. */
function defersToNextHolder(error: unknown, ctx: RepairContext): boolean {
  return error instanceof NaxError && DEFERRABLE_LOCK_CODES.has(error.code) && DEFERRING_TRIGGERS.has(ctx.trigger);
}

/** errno codes that mean "there is no such path": the only read failure that is an observation of absence. */
const MISSING_PATH_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);
/**
 * The result is read read-only and never blocking, so a FIFO where the result belongs answers the open
 * instead of waiting for a writer that may never come. A link is followed on purpose: the repair judges
 * the bytes at the path and then restores over it, replacing the link rather than writing through it.
 */
const RESULT_READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK;

/** The errno code of a thrown filesystem error, when it carries one. */
function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

/**
 * The result's raw bytes, or undefined when there is no such file.
 *
 * One read decides everything about the result: the damage the repair judges, the fingerprint the recovery
 * records, and whether the damage healed before the lock attempt. Two reads cannot be paired safely — a
 * holder that publishes a newer checkpoint between them would be fingerprinted as the damage the repair
 * never judged, and replay would then keep the stale copy over it.
 *
 * A read that fails for any reason other than absence propagates: it is not an observation of absence, and
 * recording it as one would keep a "missing" copy that replay discards as superseded the next time the
 * result is readable.
 */
async function readResultBytes(path: string): Promise<Uint8Array | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(path, RESULT_READ_FLAGS);
  } catch (error) {
    const code = errnoCode(error);
    if (code !== undefined && MISSING_PATH_CODES.has(code)) return undefined;
    throw error;
  }
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** What the repair saw on disk: no file, or the digest of the raw bytes that are there now. */
function observedDamage(bytes: Uint8Array | undefined): ResultRecovery["damaged"] {
  if (bytes === undefined) return { kind: "missing" };
  return { kind: "modified", sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
}

/** Whether the bytes are exactly the kept text: the damage healed between the damage read and the lock. */
function isKeptText(bytes: Uint8Array | undefined, content: string): boolean {
  if (bytes === undefined) return false;
  return bytes.length === Buffer.byteLength(content, "utf8") && Buffer.from(bytes).equals(Buffer.from(content, "utf8"));
}

/** What the one read proves about the keeper's snapshot: no file, different bytes, or a nax index flag. */
function damageFromRead(f: KeptFile, bytes: Uint8Array | undefined, hidden: ReadonlySet<string>): Damage[] {
  return [
    ...(bytes === undefined ? (["missing"] as const) : []),
    ...(bytes !== undefined && !isKeptText(bytes, f.content) ? (["modified"] as const) : []),
    ...(hidden.has(f.rel) ? (["hidden"] as const) : []),
  ];
}

/**
 * Keep the good copy of a damaged result for the next holder of the handoff lock (#2984), because a
 * holder outside this call tree can hold that lock through a whole CI wait.
 *
 * The recovery records the damage `observed` at the damage read, not what the result holds now: a newer
 * checkpoint the holder wrote during the failed acquisition must stay as it is, so the fingerprint it is
 * compared with on replay is the one this repair actually judged damaged. Nothing is written when the
 * damage healed while the lock was being tried: the bytes are the kept text again, so there is nothing to
 * restore and no record to report. A read that failed for a reason other than absence, and a failed
 * write, are the failure path the repair has always had.
 *
 * The recovery also carries the run's place in the newest-first ordering — the instant the keeper saved
 * this checkpoint, `f.orderedAt` — and never the moment this repair noticed the damage. A result that is
 * missing has no mtime to read, and the deferral time can be later than a newer run's checkpoint, which
 * would make replay promote this run above it and hide that run's handoff mark.
 *
 * @param f - The file the keeper holds: what the recovery restores, and where it is written beside
 * @param damage - What the damage read found, reported in the record
 * @param ctx - The repair's trigger, which the log line names
 * @param observed - The result as the one read saw it, which the recovery records
 * @returns The not-restored record, or undefined when the damage healed before the lock attempt
 */
async function deferRestore(
  f: KeptFile,
  damage: Damage[],
  ctx: RepairContext,
  observed: ResultObservation,
): Promise<RepairRecord | undefined> {
  let recoveryPath = join(dirname(f.path), RESULT_RECOVERY_FILE);
  try {
    if (isKeptText(await _repairDeps.readResultBytes(f.path), f.content)) return undefined;
    recoveryPath = await writeResultRecovery(f.path, {
      schemaVersion: 1,
      rel: f.rel,
      damaged: observedDamage(observed.bytes),
      content: f.content,
      orderedAt: f.orderedAt,
    });
  } catch (error) {
    return failedRestore(f, damage, ctx, error);
  }
  _repairDeps
    .logger()
    ?.warn(
      "runstate",
      `[WARN] ${where(ctx)}: could not restore ${f.rel}; kept it in ${recoveryPath}; the next handoff-lock holder restores it`,
      repairLogData(f, damage, ctx),
    );
  return { path: f.path, rel: f.rel, damage, restored: false };
}

async function noteInLedgers(
  keeper: RunStateKeeper,
  root: string,
  records: readonly RepairRecord[],
  ctx: RepairContext,
): Promise<void> {
  const ledgers = keeper.files().filter((f) => f.root === root && f.kind === "ledger");
  for (const ledger of ledgers) {
    for (const r of records) {
      if (!r.restored) continue;
      const line = `${ctx.storyId ?? "_run"}: run-state repaired: ${r.rel} (${r.damage.join("+")})\n`;
      await runStateWrite(ledger.path, { append: line }, () => appendFile(ledger.path, line));
    }
  }
}

interface HiddenState {
  readonly hidden: ReadonlySet<string>;
  readonly cleared: ReadonlySet<string>;
}

async function clearHidden(root: string, files: readonly KeptFile[]): Promise<HiddenState> {
  const log = _repairDeps.logger();
  const hidden = new Set(await _repairDeps.hiddenNaxPaths(root, log));
  const cleared = files.some((f) => hidden.has(f.rel)) ? await _repairDeps.clearNaxIndexFlags(root, log) : [];
  return { hidden, cleared: new Set(cleared) };
}

/** Under the path lock, judge the keeper's CURRENT bytes: a nax write recorded since the snapshot is never reverted. */
function repairLocked(
  keeper: RunStateKeeper,
  path: string,
  state: HiddenState,
  ctx: RepairContext,
): Promise<RepairRecord | undefined> {
  return withPathLock(path, async () => {
    const fresh = keeper.get(path);
    if (!fresh || keeper.isInFlight(path)) return undefined;
    const damage = await damageOf(fresh, state.hidden);
    return damage.length > 0 ? await repairFile(fresh, damage, ctx, state.cleared) : undefined;
  });
}

/** What the damage read left the repair: a damage nothing can restore, or one a deferral can hand over. */
type PendingResult =
  | { readonly kind: "hidden-only"; readonly file: KeptFile; readonly damage: Damage[] }
  | {
      readonly kind: "restorable";
      readonly file: KeptFile;
      readonly damage: Damage[];
      readonly observed: ResultObservation;
    };

async function repairResult(
  keeper: RunStateKeeper,
  path: string,
  state: HiddenState,
  ctx: RepairContext,
): Promise<RepairRecord | undefined> {
  const pending = await withPathLock(path, async (): Promise<PendingResult | undefined> => {
    const file = keeper.get(path);
    if (!file || keeper.isInFlight(path)) return undefined;
    // One read of the result: the damage it proves, and the very bytes a deferral fingerprints. Reading
    // again for the fingerprint would let a checkpoint another process publishes in between be recorded
    // as the damage this repair judged, and replay would then keep the stale copy over it.
    const observed: ResultObservation = { bytes: await _repairDeps.readResultBytes(path) };
    const damage = damageFromRead(file, observed.bytes, state.hidden);
    if (!needsRestore(damage)) return { kind: "hidden-only", file, damage };
    return { kind: "restorable", file, damage, observed };
  });
  if (!pending || pending.damage.length === 0) return undefined;
  if (pending.kind === "hidden-only") return await repairFile(pending.file, pending.damage, ctx, state.cleared);
  const { file, damage, observed } = pending;

  const workflowDir = dirname(dirname(path));
  try {
    await mkdir(workflowDir, { recursive: true });
    // Inside the publisher that holds the handoff lock (a CI-repair turn), restore under its hold:
    // deferring would let its next result write keep the damaged bytes. Its own lock-take already
    // replayed every pending recovery file, so nothing is scanned again here.
    const lockPath = handoffLockPath(workflowDir);
    if (holdsHandoffLock(lockPath)) return await repairLocked(keeper, path, state, ctx);
    // Take the handoff lock before the path lock, as result writers do, then replay whatever an earlier
    // deferral kept before judging the bytes again. One attempt only: a holder outside this call tree
    // may keep the lock through a whole CI wait, so no repair waits for it (run-end included).
    return await withFileLock(
      lockPath,
      async () => {
        await restorePendingResults(workflowDir);
        return await repairLocked(keeper, path, state, ctx);
      },
      { lockName: "handoff", errorPrefix: "[runstate]", timeoutMs: 0 },
    );
  } catch (error) {
    if (!defersToNextHolder(error, ctx)) return failedRestore(file, damage, ctx, error);
    return await deferRestore(file, damage, ctx, observed);
  }
}

async function noteInLedgersSafely(
  keeper: RunStateKeeper,
  root: string,
  records: readonly RepairRecord[],
  ctx: RepairContext,
): Promise<void> {
  try {
    await noteInLedgers(keeper, root, records, ctx);
  } catch (err) {
    _repairDeps.logger()?.warn("runstate", "Could not note run-state repair in the ledger", {
      storyId: ctx.storyId ?? "_run",
      error: errorMessage(err),
    });
  }
}

async function repairRoot(keeper: RunStateKeeper, root: string, ctx: RepairContext): Promise<RepairRecord[]> {
  const files = keeper.files().filter((f) => f.root === root && !keeper.isInFlight(f.path));
  if (files.length === 0) return [];
  const state = await clearHidden(root, files);
  const records: RepairRecord[] = [];
  for (const f of files) {
    const record =
      f.kind === "workflow-result"
        ? await repairResult(keeper, f.path, state, ctx)
        : await repairLocked(keeper, f.path, state, ctx);
    if (record) records.push(record);
  }
  if (records.length > 0) await noteInLedgersSafely(keeper, root, records, ctx);
  return records;
}

async function repairAll(ctx: RepairContext): Promise<RepairRecord[]> {
  const keepers = activeKeepers();
  const out: RepairRecord[] = [];
  for (const k of keepers) for (const root of k.roots()) out.push(...(await repairRoot(k, root, ctx)));
  // The keeper only guards files it holds; at run end the full #2490 sweep always runs.
  const sweepAll = ctx.trigger === "run-end" || ctx.trigger === "crash";
  if (ctx.workdir && (keepers.length === 0 || sweepAll)) {
    await _repairDeps.clearNaxIndexFlags(ctx.workdir, _repairDeps.logger());
  }
  return out;
}

let chain: Promise<unknown> = Promise.resolve();

/** Serialised: two sessions ending turns at once never repair concurrently. Never rejects. */
export function repairRunState(ctx: RepairContext): Promise<readonly RepairRecord[]> {
  const next = chain.then(
    () => repairAll(ctx),
    () => repairAll(ctx),
  );
  chain = next.catch(() => undefined);
  return next.catch((err: unknown) => {
    _repairDeps.logger()?.warn("runstate", "Run-state repair failed", {
      storyId: ctx.storyId ?? "_run",
      error: errorMessage(err),
    });
    return [];
  });
}
