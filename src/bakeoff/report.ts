/**
 * Bake-off Report Renderer
 *
 * Renders a `BakeoffResult` as a fixed-width terminal table. The winner
 * row is rendered first; lower-ranked rows follow in `ranking` order.
 *
 * Persistence (`bakeoff.json`) lives in `coordinator.ts` alongside the
 * other write paths so this module stays read-only.
 */

import type { BakeoffResult, ContestantResult } from "./types";

interface ColumnWidths {
  agent: number;
  status: number;
  stories: number;
  cost: number;
  wall: number;
}

const HEADERS: Record<keyof ColumnWidths, string> = {
  agent: "agent",
  status: "status",
  stories: "stories",
  cost: "costUsd",
  wall: "wallTimeMs",
};

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function formatStories(c: ContestantResult): string {
  const total = c.storiesTotal ?? c.storiesPassed;
  return `${c.storiesPassed}/${total}`;
}

function formatUsd(usd: number): string {
  return usd.toFixed(4);
}

function formatMs(ms: number): string {
  return `${ms}`;
}

function rowValues(c: ContestantResult): string[] {
  return [c.agent, c.status, formatStories(c), formatUsd(c.costUsd), formatMs(c.wallTimeMs)];
}

function computeWidths(ranking: ContestantResult[]): ColumnWidths {
  const widths: ColumnWidths = {
    agent: HEADERS.agent.length,
    status: HEADERS.status.length,
    stories: HEADERS.stories.length,
    cost: HEADERS.cost.length,
    wall: HEADERS.wall.length,
  };
  for (const c of ranking) {
    const [agent, status, stories, cost, wall] = rowValues(c);
    if (agent.length > widths.agent) widths.agent = agent.length;
    if (status.length > widths.status) widths.status = status.length;
    if (stories.length > widths.stories) widths.stories = stories.length;
    if (cost.length > widths.cost) widths.cost = cost.length;
    if (wall.length > widths.wall) widths.wall = wall.length;
  }
  return widths;
}

function renderHeader(widths: ColumnWidths): string {
  return [
    padRight(HEADERS.agent, widths.agent),
    padRight(HEADERS.status, widths.status),
    padRight(HEADERS.stories, widths.stories),
    padRight(HEADERS.cost, widths.cost),
    padRight(HEADERS.wall, widths.wall),
  ].join("  ");
}

function renderRow(c: ContestantResult, widths: ColumnWidths): string {
  const [agent, status, stories, cost, wall] = rowValues(c);
  return [
    padRight(agent, widths.agent),
    padRight(status, widths.status),
    padRight(stories, widths.stories),
    padRight(cost, widths.cost),
    padRight(wall, widths.wall),
  ].join("  ");
}

/**
 * Render a `BakeoffResult` as a human-readable terminal table.
 *
 * The returned string contains each contestant's agent, status,
 * `storiesPassed/storiesTotal`, `costUsd`, and `wallTimeMs` — with the
 * winning row (ranking[0]) appearing before any lower-ranked row.
 */
export function renderBakeoffReport(result: BakeoffResult): string {
  const widths = computeWidths(result.ranking);
  const lines: string[] = [`Bake-off result for feature: ${result.feature}`, renderHeader(widths)];
  for (const c of result.ranking) {
    lines.push(renderRow(c, widths));
  }
  return lines.join("\n");
}
