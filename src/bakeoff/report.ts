/**
 * Bake-off Report Renderer
 *
 * Renders a `BakeoffResult` as a fixed-width terminal table. The winner
 * row is rendered first; lower-ranked rows follow in `ranking` order.
 *
 * Persistence (`bakeoff.json`) lives in `coordinator.ts` alongside the
 * other write paths so this module stays read-only.
 */

import type { BakeoffResult } from "./types";

/**
 * Render a `BakeoffResult` as a human-readable terminal table.
 *
 * The returned string contains each contestant's agent, status,
 * `storiesPassed/storiesTotal`, `costUsd`, and `wallTimeMs` — with the
 * winning row (ranking[0]) appearing before any lower-ranked row.
 */
export function renderBakeoffReport(result: BakeoffResult): string {
  throw new Error("not implemented"); // nax-lint-allow: plain-error
}
