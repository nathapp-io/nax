/**
 * Review #19: the cache boundary judges only RETURNED patches, but handlers
 * receive the loop's live arrays (history, messages, tools). A handler that
 * edits one in place would rewrite the transcript and the prompt-cache
 * prefix unseen. Dispatch snapshots every array field before each handler and
 * undoes an in-place change afterwards, keeping the SAME array object with
 * its original elements.
 *
 * Not detected: edits INSIDE an element (a message's fields). Deep-freezing
 * is not an option: the payload is live, and the loop itself pushes onto
 * `messages` after a follow-up; freezing a clone would break the reference
 * identity checkPrefixStable relies on.
 */
import { getSafeLogger } from "@/logger";

interface ArrayRecord {
  readonly field: string;
  readonly array: unknown[];
  readonly saved: readonly unknown[];
}

export type ArraySnapshot = readonly ArrayRecord[];

export function snapshotArrays(payload: object): ArraySnapshot {
  return Object.entries(payload).flatMap(([field, value]) =>
    Array.isArray(value) ? [{ field, array: value, saved: [...value] }] : [],
  );
}

export function restoreMutated(snapshot: ArraySnapshot, event: string, handlerIndex: number): void {
  for (const { field, array, saved } of snapshot) {
    const changed = array.length !== saved.length || saved.some((item, i) => array[i] !== item);
    if (!changed) continue;
    getSafeLogger()?.warn("native-loop-events", "handler mutated payload in place; restored", {
      event,
      handler: handlerIndex,
      field,
    });
    // Deliberate in-place restore: the caller holds this exact array object.
    array.splice(0, array.length, ...saved);
  }
}
