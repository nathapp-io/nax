import { getSafeLogger } from "@/logger";

export function checkPrefixStable(
  before: readonly unknown[],
  after: readonly unknown[],
  anchorIndex: number | undefined,
): boolean {
  // No anchor means no cached prefix to protect (spec 3.5).
  if (anchorIndex === undefined) return true;
  const end = Math.min(anchorIndex, before.length - 1);
  if (after.length <= end) return false;
  for (let i = 0; i <= end; i += 1) {
    // Reference identity: an equal-valued rebuild still breaks the wire cache.
    if (before[i] !== after[i]) return false;
  }
  return true;
}

export function applyHistoryPatch<T>(args: {
  readonly before: readonly T[];
  readonly patched: readonly T[] | undefined;
  readonly anchorIndex: number | undefined;
  readonly boundary: boolean;
  readonly event: string;
}): { readonly messages: readonly T[]; readonly honoured: boolean } {
  const { before, patched, anchorIndex, boundary, event } = args;
  if (patched === undefined) return { messages: before, honoured: false };
  if (boundary || checkPrefixStable(before, patched, anchorIndex)) {
    return { messages: patched, honoured: true };
  }
  getSafeLogger()?.warn("native-loop-events", "history patch rejected: prefix rewritten off-boundary", {
    event,
    ...(anchorIndex !== undefined ? { anchorIndex } : {}),
  });
  // What stops is the PATCH, never the turn (spec 3.7).
  return { messages: before, honoured: false };
}
