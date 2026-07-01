import type { ScheduleParseResult } from "./types";

const ACCEPTED =
  "Accepted: relative (30m, 2h, 90s, 1h30m, 1d), time-of-day (17:00), or ISO datetime (2026-07-02T02:00).";

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const DURATION_RE = /^(\d+[smhd])+$/;
const SEGMENT_RE = /(\d+)([smhd])/g;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseTimeOfDay(input: string, now: Date): ScheduleParseResult | null {
  const m = TIME_RE.exec(input);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1); // roll to tomorrow
  }
  return { ok: true, target };
}

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

  const timeOfDay = parseTimeOfDay(trimmed, now);
  if (timeOfDay) return timeOfDay;

  return { ok: false, error: `Unrecognized schedule "${input}". ${ACCEPTED}` };
}
