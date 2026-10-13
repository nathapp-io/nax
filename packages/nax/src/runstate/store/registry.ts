/**
 * Process-wide set of active run-state keepers (#2497), the same shape as the tool-audit sink
 * registry. Writers call runStateWrite; with no keeper active it only runs the write.
 */
import { resolve } from "node:path";
import type { RunStateKeeper } from "./keeper";
import { classifyRunStatePath, type RunStatePath } from "./paths";

export type WriteIntent = { readonly content: string } | { readonly append: string };

const active = new Set<RunStateKeeper>();

/** Tail of the serialized write chain per absolute path. Entries are removed when their chain drains. */
const chains = new Map<string, Promise<void>>();

export function registerKeeper(k: RunStateKeeper): void {
  active.add(k);
}

export function unregisterKeeper(k: RunStateKeeper): void {
  active.delete(k);
}

export function activeKeepers(): readonly RunStateKeeper[] {
  return [...active];
}

async function baseContent(keeper: RunStateKeeper, path: string): Promise<string> {
  const kept = keeper.get(path);
  if (kept) return kept.content;
  const file = Bun.file(path);
  return (await file.exists()) ? await file.text() : "";
}

/** Run `task` after every earlier write queued for `abs` has settled (fulfilled or rejected). */
function serialized<T>(abs: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(abs) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail: Promise<void> = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(abs, tail);
  void tail.then(() => {
    if (chains.get(abs) === tail) chains.delete(abs);
  });
  return run;
}

/** Compute every keeper's content before any mark is set, so a read failure leaves no keeper in flight. */
async function contentsFor(
  keepers: readonly RunStateKeeper[],
  abs: string,
  intent: WriteIntent,
): Promise<readonly (readonly [RunStateKeeper, string])[]> {
  const out: (readonly [RunStateKeeper, string])[] = [];
  for (const k of keepers) {
    const content = "content" in intent ? intent.content : `${await baseContent(k, abs)}${intent.append}`;
    out.push([k, content]);
  }
  return out;
}

async function recordThenWrite(
  abs: string,
  classified: RunStatePath,
  intent: WriteIntent,
  write: () => Promise<void>,
): Promise<void> {
  const keepers = [...active].filter((k) => k.owns(classified));
  if (keepers.length === 0) return write();
  const contents = await contentsFor(keepers, abs, intent);
  for (const [k, content] of contents) {
    k.record(abs, classified, content);
    k.begin(abs);
  }
  try {
    await write();
  } finally {
    for (const k of keepers) k.end(abs);
  }
}

/**
 * Record the intent first, so a concurrent repair restores exactly what nax is writing, then write.
 * Writes to one path are serialized so an append reads the base the previous append recorded.
 */
export async function runStateWrite(path: string, intent: WriteIntent, write: () => Promise<void>): Promise<void> {
  const abs = resolve(path);
  const classified = classifyRunStatePath(abs);
  if (!classified || ![...active].some((k) => k.owns(classified))) return write();
  return serialized(abs, () => recordThenWrite(abs, classified, intent, write));
}

/** Run `task` under the same per-path lock runStateWrite holds, so it never interleaves with a nax write to `path`. */
export function withPathLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  return serialized(resolve(path), task);
}
