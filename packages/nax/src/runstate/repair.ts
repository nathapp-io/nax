/** Detect and repair agent damage to nax run state (#2497). Never throws. */
import { appendFile, mkdir, rename } from "node:fs/promises";
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
};

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

/** The result's bytes as they are now, or undefined when there is no readable file there. */
async function currentBytes(path: string): Promise<Uint8Array | undefined> {
  try {
    return await Bun.file(path).bytes();
  } catch {
    // No readable file: the observation is "nothing there", which is the damage worth recording.
    return undefined;
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

/**
 * Keep the good copy of a damaged result for the next holder of the handoff lock (#2984), because a
 * holder outside this call tree can hold that lock through a whole CI wait.
 *
 * Nothing is written when the damage healed while the lock was being tried: the bytes are the kept text
 * again, so there is nothing to restore and no record to report. A failed write is the failure path the
 * repair has always had.
 *
 * @param f - The file the keeper holds: what the recovery restores, and where it is written beside
 * @param damage - What the damage read found, reported in the record
 * @param ctx - The repair's trigger, which the log line names
 * @returns The not-restored record, or undefined when the damage healed before the lock attempt
 */
async function deferRestore(f: KeptFile, damage: Damage[], ctx: RepairContext): Promise<RepairRecord | undefined> {
  const bytes = await currentBytes(f.path);
  if (isKeptText(bytes, f.content)) return undefined;
  const recoveryPath = join(dirname(f.path), RESULT_RECOVERY_FILE);
  try {
    await writeResultRecovery(f.path, {
      schemaVersion: 1,
      rel: f.rel,
      damaged: observedDamage(bytes),
      content: f.content,
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

async function repairResult(
  keeper: RunStateKeeper,
  path: string,
  state: HiddenState,
  ctx: RepairContext,
): Promise<RepairRecord | undefined> {
  const pending = await withPathLock(path, async () => {
    const file = keeper.get(path);
    if (!file || keeper.isInFlight(path)) return undefined;
    return { file, damage: await damageOf(file, state.hidden) };
  });
  if (!pending || pending.damage.length === 0) return undefined;
  const { file, damage } = pending;
  if (!needsRestore(damage)) return await repairFile(file, damage, ctx, state.cleared);

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
    return await deferRestore(file, damage, ctx);
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
