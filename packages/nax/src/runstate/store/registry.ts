/**
 * Process-wide set of active run-state keepers (#2497), the same shape as the tool-audit sink
 * registry. Writers call runStateWrite; with no keeper active it only runs the write.
 */
import { resolve } from "node:path";
import type { RunStateKeeper } from "./keeper";
import { classifyRunStatePath } from "./paths";

export type WriteIntent = { readonly content: string } | { readonly append: string };

const active = new Set<RunStateKeeper>();

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

/** Record the intent first, so a concurrent repair restores exactly what nax is writing, then write. */
export async function runStateWrite(path: string, intent: WriteIntent, write: () => Promise<void>): Promise<void> {
  const abs = resolve(path);
  const classified = classifyRunStatePath(abs);
  const keepers = classified ? [...active].filter((k) => k.owns(classified)) : [];
  if (!classified || keepers.length === 0) return write();
  for (const k of keepers) {
    const content = "content" in intent ? intent.content : `${await baseContent(k, abs)}${intent.append}`;
    k.record(abs, classified, content);
    k.begin(abs);
  }
  try {
    await write();
  } finally {
    for (const k of keepers) k.end(abs);
  }
}
