import type { ScheduleParseResult } from "./types";

const ACCEPTED =
  "Accepted: relative (30m, 2h, 90s, 1h30m, 1d), time-of-day (17:00), or ISO datetime (2026-07-02T02:00).";

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const DURATION_RE = /^(\d+[smhd])+$/;
const SEGMENT_RE = /(\d+)([smhd])/g;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Naive: YYYY-MM-DDTHH:MM(:SS)? with NO offset/Z. Construct explicitly as local.
const NAIVE_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
// Date-only: YYYY-MM-DD with no time component.
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
// Has an explicit offset or Z after a time component.
const OFFSET_RE = /T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

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

function parseIso(input: string, now: Date): ScheduleParseResult {
  if (DATE_ONLY_RE.test(input)) {
    return {
      ok: false,
      error: `Date-only value "${input}" has no time — specify a time, e.g. ${input}T02:00.`,
    };
  }

  let target: Date | null = null;

  const naive = NAIVE_RE.exec(input);
  if (naive) {
    const [, y, mo, d, h, mi, s] = naive;
    // Explicit local-time construction — avoids new Date()'s date-only-UTC footgun.
    target = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? "0"), 0);
  } else if (OFFSET_RE.test(input)) {
    const parsed = new Date(input);
    if (!Number.isNaN(parsed.getTime())) target = parsed;
  }

  if (!target || Number.isNaN(target.getTime())) {
    return { ok: false, error: `Unrecognized schedule "${input}". ${ACCEPTED}` };
  }
  if (target.getTime() <= now.getTime()) {
    return { ok: false, error: `Scheduled time ${input} is in the past.` };
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

export type ScheduleGateResult = { ok: true; target: Date | null } | { ok: false; error: string };

export function resolveScheduleGate(input: string | undefined, now: Date): ScheduleGateResult {
  if (input === undefined) return { ok: true, target: null };
  const parsed = parseSchedule(input, now);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, target: parsed.target };
}

export function parseSchedule(input: string, now: Date): ScheduleParseResult {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, error: `Empty schedule value. ${ACCEPTED}` };

  const relative = parseRelative(trimmed, now);
  if (relative) return relative;

  const timeOfDay = parseTimeOfDay(trimmed, now);
  if (timeOfDay) return timeOfDay;

  return parseIso(trimmed, now);
}
