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
// The calendar components a naive or offset value states, before any Date builds one.
const CALENDAR_PREFIX_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Gregorian leap rule: divisible by 4, except centuries not divisible by 400. */
function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month - 1] ?? 0;
}

/**
 * True when the stated components name a month, day or time that does not
 * exist. `Date` normalises them silently — `new Date(2027, 1, 29)` is March 1,
 * `new Date(2027, 3, 31)` is May 1, `new Date(2027, 2, 1, 24)` is the next day
 * and second 60 is the next minute — so the check has to run first, and the
 * value is rejected rather than quietly scheduled a day late.
 */
function namesImpossibleInstant([, year, month, day, hour, minute, second]: RegExpExecArray): boolean {
  const monthNumber = Number(month);
  if (monthNumber < 1 || monthNumber > 12) return true;
  const dayNumber = Number(day);
  if (dayNumber < 1 || dayNumber > daysInMonth(Number(year), monthNumber)) return true;
  if (Number(hour) > 23 || Number(minute) > 59) return true;
  return second !== undefined && Number(second) > 59;
}

/** Runs before a naive or offset value is handed to `Date`. */
function rejectsCalendar(input: string): ScheduleParseResult | null {
  const prefix = CALENDAR_PREFIX_RE.exec(input);
  // An offset value with no leading YYYY-MM-DDTHH:MM keeps today's path: it has
  // no calendar components to check and ends as `Unrecognized schedule`.
  if (!prefix || !namesImpossibleInstant(prefix)) return null;
  return { ok: false, error: `Schedule "${input}" names a date or time that does not exist.` };
}

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
  const offsetForm = naive === null && OFFSET_RE.test(input);

  if (naive || offsetForm) {
    const rejected = rejectsCalendar(input);
    if (rejected) return rejected;
  }

  if (naive) {
    const [, y, mo, d, h, mi, s] = naive;
    // Explicit local-time construction — avoids new Date()'s date-only-UTC footgun.
    target = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? "0"), 0);
  } else if (offsetForm) {
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
  const target = new Date(now.getTime() + totalMs);
  if (!Number.isFinite(target.getTime())) {
    return { ok: false, error: `Duration "${input}" is not representable as a date. ${ACCEPTED}` };
  }
  return { ok: true, target };
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
