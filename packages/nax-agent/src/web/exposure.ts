/**
 * Web exposure: what a chat session remembers once it has read the web.
 *
 * A session becomes exposed the first time a web tool returns a result to the
 * model, and stays exposed for the rest of its life -- there is no reset. Along
 * with the marker the state holds the URLs the session may fetch without asking
 * (bounded by `WEB_SEEN_URL_CAP`, oldest dropped first) and how many searches
 * succeeded. `onChange` is how the host persists it: the subscriber writes the
 * snapshot to the stored session meta as it changes, so a crash mid-turn cannot
 * lose the exposure.
 *
 * Named "exposure", never "taint": the approvals cache has its own taint
 * (`permissions/approvals-taint.ts`), and the two mean different things.
 */

import { normalizeWebUrl } from "./content.ts";
import { WEB_SEEN_URL_CAP, type WebExposureSnapshot } from "./types.ts";

/** The per-session exposure state one chat session owns. */
export interface WebExposure {
  /** Whether a web tool has already returned a result to the model. */
  isExposed(): boolean;
  /** Mark the session exposed, recording the time of the first result. No-op once exposed. */
  markExposed(now: Date): void;
  /** Record URLs the session may fetch without asking: normalised, deduped, capped. */
  recordUrls(urls: readonly string[]): void;
  /** Whether `url` is one of the recorded URLs, compared in its normalised spelling. */
  hasSeen(url: string): boolean;
  /** Count one successful search. */
  countSearch(): void;
  /** A copy of the current state, safe to persist or hand to a listener. */
  snapshot(): WebExposureSnapshot;
  /** Call `listener` with the new snapshot after every change; returns the unsubscribe. */
  onChange(listener: (s: WebExposureSnapshot) => void): () => void;
}

type ExposureListener = (s: WebExposureSnapshot) => void;

/**
 * The exposure state, optionally restored from a stored snapshot (`initial`), so
 * a resumed or compacted session keeps its marker, its seen URLs and its count.
 *
 * Every view of the state is a copy: `snapshot()` and every listener get their own
 * array, so a caller that mutates what it was handed cannot corrupt the state or
 * another listener's view of it.
 */
export function createWebExposure(initial?: WebExposureSnapshot): WebExposure {
  let exposedAt: string | null = initial?.exposedAt ?? null;
  // Insertion order IS the eviction order: the head is the oldest URL, so passing
  // the cap drops from the front and a long session keeps its most recent links.
  const seenOrder: string[] = [];
  // `seenOrder` alone would make `hasSeen` a linear scan of up to 2000 entries on
  // every fetch, so membership lives in a set beside the order.
  const seen = new Set<string>();
  let searches = initial?.searches ?? 0;
  const listeners = new Set<ExposureListener>();

  /**
   * Drop the oldest URLs until the set is back inside the cap. The one eviction
   * rule, applied to both a restored snapshot and every later `recordUrls`, so the
   * order array and the membership set can never drift apart.
   */
  function evictPastCap(): void {
    while (seenOrder.length > WEB_SEEN_URL_CAP) {
      const evicted = seenOrder.shift();
      if (evicted !== undefined) seen.delete(evicted);
    }
  }

  /**
   * Restored state is trusted but not assumed well-formed: a duplicate would make
   * the order and the set disagree, and an over-cap array would break the bound the
   * cap exists to guarantee. Both are reduced here so the invariant holds for every
   * snapshot this instance ever hands out.
   */
  function restore(urls: readonly string[]): void {
    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.add(url);
      seenOrder.push(url);
    }
    evictPastCap();
  }

  function snapshot(): WebExposureSnapshot {
    return { exposedAt, seenUrls: [...seenOrder], searches };
  }

  /**
   * Tell every listener the state changed. The mutation has already happened, so a
   * listener that throws cannot corrupt the state -- and its failure is NOT swallowed:
   * the subscriber is the persistence path, and a write that silently failed is
   * exactly what the "every change is written at once" rule exists to prevent.
   * Iterating a copy means a listener may unsubscribe while it is being told.
   */
  function emit(): void {
    if (listeners.size === 0) return;
    const next = snapshot();
    for (const listener of [...listeners]) listener(next);
  }

  restore(initial?.seenUrls ?? []);

  return {
    isExposed(): boolean {
      return exposedAt !== null;
    },
    markExposed(now: Date): void {
      // The FIRST result is the one that matters; a later one cannot move the time.
      if (exposedAt !== null) return;
      exposedAt = now.toISOString();
      emit();
    },
    recordUrls(urls: readonly string[]): void {
      let added = false;
      for (const raw of urls) {
        const url = normalizeWebUrl(raw);
        if (url === null || seen.has(url)) continue;
        seen.add(url);
        seenOrder.push(url);
        added = true;
      }
      // Nothing new is not a change: a page whose links the session already holds
      // must not rewrite the stored meta.
      if (!added) return;
      evictPastCap();
      emit();
    },
    hasSeen(url: string): boolean {
      const normalized = normalizeWebUrl(url);
      return normalized !== null && seen.has(normalized);
    },
    countSearch(): void {
      searches += 1;
      emit();
    },
    snapshot,
    onChange(listener: ExposureListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
