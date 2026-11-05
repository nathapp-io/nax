/**
 * The `data` koda answers on its memory LIST route, `GET projects/<slug>/memory`.
 *
 * Contract fixture: the shape comes from koda, not from the provider's own reading of it, so
 * a stub cannot drift from the route again (#2791). Derived from koda at 0f77044e
 * (apps/api/src/memory/memory-read.controller.ts `getMemory`, which answers
 * `toPageResult(page)` from apps/api/src/common/dto/koda-page.query.ts):
 * `{ total, current, size, hasNext, hasPrev, records }`.
 *
 * Only the EXPORT route (`GET projects/<slug>/memory/export`) answers `{ items, nextCursor,
 * hasMore }`; a list stub must never carry `items`.
 */

/** The page envelope the list route answers in `data`. */
export interface KodaListData {
  readonly total: number;
  readonly current: number;
  readonly size: number;
  readonly hasNext: boolean;
  readonly hasPrev: boolean;
  readonly records: readonly unknown[];
}

/**
 * One list page holding `records`, as koda frames it.
 *
 * @param records - The page's rows
 * @param over - Envelope fields a case sets (`hasNext`, `current`, ...)
 */
export function kodaListData(records: readonly unknown[], over: Partial<KodaListData> = {}): KodaListData {
  const current = over.current ?? 1;
  return {
    total: records.length,
    current,
    size: 100,
    hasNext: false,
    hasPrev: current > 1,
    records,
    ...over,
  };
}
