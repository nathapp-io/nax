import type { ScheduleParseResult } from "./types";

const ACCEPTED =
  "Accepted: relative (30m, 2h, 90s, 1h30m, 1d), time-of-day (17:00), or ISO datetime (2026-07-02T02:00).";

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const DURATION_RE = /^(\d+[smhd])+$/;
const SEGMENT_RE = /(\d+)([smhd])/g;

function parseRelative(input: string, now: Date): ScheduleParseResult | null {
  if (!DURATION_RE.test(input)) return null;
  let totalMs = 0;
  for (const [, n, unit] of input.matchAll(SEGMENT_RE)) {
    totalMs += Number(n) * UNIT_MS[unit];
  }
  if (totalMs <= 0) return { ok: false, error: `Duration must be positive. ${ACCEPTED}` };
  return { ok: true, target: new Date(now.getTime() + totalMs) };
}

export function parseSchedule(input: string, now: Date): ScheduleParseResult {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, error: `Empty schedule value. ${ACCEPTED}` };

  const relative = parseRelative(trimmed, now);
  if (relative) return relative;

  return { ok: false, error: `Unrecognized schedule "${input}". ${ACCEPTED}` };
}
