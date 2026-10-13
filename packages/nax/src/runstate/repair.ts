/** Detect and repair agent damage to nax run state (#2497). Never throws. */
import { appendFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getSafeLogger } from "../logger";
import { clearNaxIndexFlags, hiddenNaxPaths, type IndexFlagLogger } from "../utils/nax-index-flags";
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
  const log = _repairDeps.logger();
  const data = {
    storyId: ctx.storyId ?? "_run",
    sessionName: ctx.sessionName,
    stage: ctx.stage,
    turn: ctx.turn,
    trigger: ctx.trigger,
    path: f.rel,
    damage,
  };
  try {
    if (damage.includes("missing") || damage.includes("modified")) await restore(f);
    const restored = !damage.includes("hidden") || cleared.has(f.rel);
    if (restored) log?.warn("runstate", `${where(ctx)}: ${f.rel} ${damage.join("+")} by the agent; restored`, data);
    else log?.warn("runstate", `[FAIL] ${where(ctx)}: could not clear the index flag on ${f.rel}`, data);
    return { path: f.path, rel: f.rel, damage, restored };
  } catch (err) {
    log?.warn("runstate", `[FAIL] ${where(ctx)}: could not restore ${f.rel}`, { ...data, error: errorMessage(err) });
    return { path: f.path, rel: f.rel, damage, restored: false };
  }
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
    const record = await repairLocked(keeper, f.path, state, ctx);
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
