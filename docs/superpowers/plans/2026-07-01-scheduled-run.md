# Scheduled Run (`nax run --schedule`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-shot, foreground `--schedule <when>` flag to `nax run` that defers the run start until a wall-clock trigger, showing a live countdown, then hands off to the existing run path.

**Architecture:** Two small dependency-injected modules under `src/schedule/` — a pure parser (`parseSchedule(input, now) → target|error`) and a countdown gate (`waitForSchedule(target, opts) → "fired"|"cancelled"`). The CLI parses `--schedule` early (fail fast), then calls the gate immediately before the existing `run({...})` invocation in `bin/nax.ts`. No daemon, no persistence, no reboot survival.

**Tech Stack:** Bun 1.3.7+, TypeScript strict, `bun:test`, commander (CLI), chalk (output). Reuses `cancellableDelay` from `src/utils/bun-deps.ts` and `NaxError` from `src/errors.ts`.

## Global Constraints

- **Bun-native only** — no Node.js `fs`/`child_process`/`setTimeout`-for-delay. Delays use `cancellableDelay(ms, signal)` from `src/utils/bun-deps.ts`.
- **TypeScript strict** — no `any` without justification.
- **Barrel imports** — consumers import from `@/schedule`, never `@/schedule/parse`. Every dir with 2+ exports gets an `index.ts`.
- **File size** — source ≤ 600 lines, test ≤ 800 lines. All files here are far smaller.
- **Errors** — use `NaxError(message, code, context)`; expected bad input returns a structured result, not a throw.
- **Logging** — project logger (`src/logger`), never `console.log` in `src/`. (CLI entry `bin/nax.ts` already uses `console` + chalk for user-facing output — match that locally.)
- **Test commands** — never bare `bun test`. Use `timeout 15 bun test <path> --timeout=5000`.
- **Tests use `_deps` injection** — never `mock.module()`; never `Bun.sleep()` in tests.
- **Conventional commits**, one concern per commit, no attribution.

---

## File Structure

- `src/schedule/types.ts` — `ScheduleParseResult` discriminated union.
- `src/schedule/parse.ts` — pure `parseSchedule(input, now)`.
- `src/schedule/wait.ts` — `waitForSchedule(target, opts)` countdown gate with `_deps`.
- `src/schedule/index.ts` — barrel re-exporting the above.
- `bin/nax.ts` — add `--schedule` option + gate wiring before `run({...})` (line ~641).
- `test/unit/schedule/parse.test.ts` — parser table tests.
- `test/unit/schedule/wait.test.ts` — countdown/cancel tests with fake clock.
- `test/unit/schedule/format.test.ts` — remaining-time formatting (folded into wait.ts).

---

## Task 1: Schedule parser — types + relative durations

**Files:**
- Create: `src/schedule/types.ts`
- Create: `src/schedule/parse.ts`
- Create: `src/schedule/index.ts`
- Test: `test/unit/schedule/parse.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ScheduleParseResult = { ok: true; target: Date } | { ok: false; error: string }`
  - `function parseSchedule(input: string, now: Date): ScheduleParseResult`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/schedule/parse.test.ts
import { describe, expect, test } from "bun:test";
import { parseSchedule } from "@/schedule";

const NOW = new Date("2026-07-01T12:00:00"); // local

describe("parseSchedule — relative durations", () => {
  test.each([
    ["30m", 30 * 60_000],
    ["2h", 2 * 3_600_000],
    ["90s", 90_000],
    ["1h30m", 90 * 60_000],
    ["1d", 86_400_000],
  ])("%s → now + %d ms", (input, deltaMs) => {
    const r = parseSchedule(input as string, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target.getTime()).toBe(NOW.getTime() + (deltaMs as number));
  });

  test.each(["0s", "5x", "m30", "1h30", "-5m", ""])("rejects %p", (input) => {
    const r = parseSchedule(input as string, NOW);
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 15 bun test test/unit/schedule/parse.test.ts --timeout=5000`
Expected: FAIL — cannot resolve `@/schedule`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/schedule/types.ts
export type ScheduleParseResult =
  | { ok: true; target: Date }
  | { ok: false; error: string };
```

```typescript
// src/schedule/parse.ts
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
```

```typescript
// src/schedule/index.ts
export { parseSchedule } from "./parse";
export type { ScheduleParseResult } from "./types";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 15 bun test test/unit/schedule/parse.test.ts --timeout=5000`
Expected: PASS (all relative + rejection cases).

- [ ] **Step 5: Commit**

```bash
git add src/schedule/ test/unit/schedule/parse.test.ts
git commit -m "feat(schedule): add parseSchedule with relative-duration support"
```

---

## Task 2: Schedule parser — time-of-day (`HH:MM`) with roll-to-tomorrow

**Files:**
- Modify: `src/schedule/parse.ts`
- Test: `test/unit/schedule/parse.test.ts` (add describe block)

**Interfaces:**
- Consumes: `parseSchedule` from Task 1.
- Produces: `HH:MM` handling — same `parseSchedule` signature.

- [ ] **Step 1: Write the failing test**

```typescript
// append to test/unit/schedule/parse.test.ts
describe("parseSchedule — time of day", () => {
  const noon = new Date("2026-07-01T12:00:00");

  test("future time today stays today", () => {
    const r = parseSchedule("17:00", noon);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.target.getFullYear()).toBe(2026);
      expect(r.target.getMonth()).toBe(6); // July
      expect(r.target.getDate()).toBe(1);
      expect(r.target.getHours()).toBe(17);
      expect(r.target.getMinutes()).toBe(0);
      expect(r.target.getSeconds()).toBe(0);
    }
  });

  test("past time today rolls to tomorrow", () => {
    const r = parseSchedule("09:30", noon);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.target.getDate()).toBe(2); // rolled to July 2
      expect(r.target.getHours()).toBe(9);
      expect(r.target.getMinutes()).toBe(30);
    }
  });

  test.each(["24:00", "12:60", "9:5", "17:0"])("rejects malformed %p", (input) => {
    expect(parseSchedule(input as string, noon).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 15 bun test test/unit/schedule/parse.test.ts --timeout=5000`
Expected: FAIL — `17:00` currently hits the "Unrecognized" branch.

- [ ] **Step 3: Write minimal implementation**

Add above the final `return` in `parseSchedule`, and add the helper:

```typescript
// src/schedule/parse.ts — add helper
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseTimeOfDay(input: string, now: Date): ScheduleParseResult | null {
  const m = TIME_RE.exec(input);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  const target = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hours,
    minutes,
    0,
    0,
  );
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1); // roll to tomorrow
  }
  return { ok: true, target };
}
```

```typescript
// src/schedule/parse.ts — in parseSchedule, before the final return:
  const timeOfDay = parseTimeOfDay(trimmed, now);
  if (timeOfDay) return timeOfDay;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 15 bun test test/unit/schedule/parse.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/schedule/parse.ts test/unit/schedule/parse.test.ts
git commit -m "feat(schedule): add time-of-day parsing with roll-to-tomorrow"
```

---

## Task 3: Schedule parser — ISO datetime, local tz, past-error, date-only reject

**Files:**
- Modify: `src/schedule/parse.ts`
- Test: `test/unit/schedule/parse.test.ts` (add describe block)

**Interfaces:**
- Consumes: `parseSchedule` from Task 2.
- Produces: ISO datetime handling — same signature. This is the terminal branch (replaces the "Unrecognized" fallthrough for ISO-shaped input).

- [ ] **Step 1: Write the failing test**

```typescript
// append to test/unit/schedule/parse.test.ts
describe("parseSchedule — ISO datetime", () => {
  const now = new Date("2026-07-01T12:00:00");

  test("naive datetime is interpreted as local time", () => {
    const r = parseSchedule("2026-07-02T02:00", now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.target.getFullYear()).toBe(2026);
      expect(r.target.getDate()).toBe(2);
      expect(r.target.getHours()).toBe(2); // local, not UTC
      expect(r.target.getMinutes()).toBe(0);
    }
  });

  test("explicit Z offset is honored", () => {
    const r = parseSchedule("2026-07-02T02:00:00Z", now);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target.getTime()).toBe(Date.parse("2026-07-02T02:00:00Z"));
  });

  test("past datetime errors", () => {
    const r = parseSchedule("2026-06-01T00:00", now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("past");
  });

  test("bare date-only is rejected", () => {
    const r = parseSchedule("2026-07-02", now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("time");
  });

  test("garbage is rejected", () => {
    expect(parseSchedule("not-a-date", now).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 15 bun test test/unit/schedule/parse.test.ts --timeout=5000`
Expected: FAIL — ISO inputs currently hit "Unrecognized".

- [ ] **Step 3: Write minimal implementation**

Add helpers and replace the final `return` in `parseSchedule`:

```typescript
// src/schedule/parse.ts — add helpers
// Naive: YYYY-MM-DDTHH:MM(:SS)? with NO offset/Z. Construct explicitly as local.
const NAIVE_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
// Date-only: YYYY-MM-DD with no time component.
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
// Has an explicit offset or Z after a time component.
const OFFSET_RE = /T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

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
```

```typescript
// src/schedule/parse.ts — replace the final `return { ok:false, error:"Unrecognized..." }`
  return parseIso(trimmed, now);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 15 bun test test/unit/schedule/parse.test.ts --timeout=5000`
Expected: PASS (all parse describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/schedule/parse.ts test/unit/schedule/parse.test.ts
git commit -m "feat(schedule): add ISO datetime parsing with local-tz + past guard"
```

---

## Task 4: Countdown gate — `formatRemaining` helper

**Files:**
- Create: `src/schedule/wait.ts`
- Modify: `src/schedule/index.ts`
- Test: `test/unit/schedule/format.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `function formatRemaining(ms: number): string` — `HH:MM:SS`, clamps negatives to `00:00:00`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/schedule/format.test.ts
import { describe, expect, test } from "bun:test";
import { formatRemaining } from "@/schedule";

describe("formatRemaining", () => {
  test.each([
    [0, "00:00:00"],
    [-5_000, "00:00:00"],
    [1_000, "00:00:01"],
    [61_000, "00:01:01"],
    [3_661_000, "01:01:01"],
    [90_061_000, "25:01:01"], // > 24h stays in hours
  ])("%d ms → %s", (ms, expected) => {
    expect(formatRemaining(ms as number)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 15 bun test test/unit/schedule/format.test.ts --timeout=5000`
Expected: FAIL — `formatRemaining` not exported.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/schedule/wait.ts
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}
```

```typescript
// src/schedule/index.ts — add
export { formatRemaining, waitForSchedule } from "./wait";
export type { WaitDeps, WaitOutcome } from "./wait";
```

> Note: `waitForSchedule`/`WaitDeps`/`WaitOutcome` are added in Task 5. Add the full export line now; Task 5 makes it resolve. If running tasks strictly independently, temporarily export only `formatRemaining` here and add the rest in Task 5.

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 15 bun test test/unit/schedule/format.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/schedule/wait.ts src/schedule/index.ts test/unit/schedule/format.test.ts
git commit -m "feat(schedule): add formatRemaining countdown helper"
```

---

## Task 5: Countdown gate — `waitForSchedule` with fake clock + cancellation

**Files:**
- Modify: `src/schedule/wait.ts`
- Modify: `src/schedule/index.ts` (ensure full export line from Task 4)
- Test: `test/unit/schedule/wait.test.ts`

**Interfaces:**
- Consumes: `formatRemaining`, `cancellableDelay` from `@/utils/bun-deps`.
- Produces:
  - `type WaitOutcome = "fired" | "cancelled"`
  - `interface WaitDeps { now: () => number; delay: (ms: number, signal?: AbortSignal) => Promise<void>; render: (line: string) => void; }`
  - `function waitForSchedule(target: Date, opts: { label: string; headless: boolean; signal: AbortSignal; _deps?: Partial<WaitDeps> }): Promise<WaitOutcome>`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/schedule/wait.test.ts
import { describe, expect, test } from "bun:test";
import { waitForSchedule } from "@/schedule";

function fakeDeps(startMs: number, stepMs: number) {
  let current = startMs;
  const lines: string[] = [];
  return {
    lines,
    deps: {
      now: () => current,
      // Each "delay" advances the fake clock by stepMs instead of waiting.
      delay: async (_ms: number, signal?: AbortSignal) => {
        if (signal?.aborted) throw new Error("aborted");
        current += stepMs;
      },
      render: (line: string) => lines.push(line),
    },
  };
}

describe("waitForSchedule", () => {
  test("counts down and fires at target", async () => {
    const start = 1_000_000;
    const { lines, deps } = fakeDeps(start, 1_000);
    const target = new Date(start + 3_000);
    const outcome = await waitForSchedule(target, {
      label: "feat-x",
      headless: false,
      signal: new AbortController().signal,
      _deps: deps,
    });
    expect(outcome).toBe("fired");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes("feat-x"))).toBe(true);
  });

  test("returns cancelled when signal aborts", async () => {
    const start = 1_000_000;
    const controller = new AbortController();
    const { deps } = fakeDeps(start, 1_000);
    // Abort immediately; delay throws → treated as cancellation.
    controller.abort();
    const outcome = await waitForSchedule(new Date(start + 60_000), {
      label: "feat-x",
      headless: false,
      signal: controller.signal,
      _deps: deps,
    });
    expect(outcome).toBe("cancelled");
  });

  test("headless emits no render lines", async () => {
    const start = 1_000_000;
    const { lines, deps } = fakeDeps(start, 5_000);
    const outcome = await waitForSchedule(new Date(start + 3_000), {
      label: "feat-x",
      headless: true,
      signal: new AbortController().signal,
      _deps: deps,
    });
    expect(outcome).toBe("fired");
    expect(lines.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 15 bun test test/unit/schedule/wait.test.ts --timeout=5000`
Expected: FAIL — `waitForSchedule` not defined.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/schedule/wait.ts — add below formatRemaining
import { cancellableDelay } from "@/utils/bun-deps";

export type WaitOutcome = "fired" | "cancelled";

export interface WaitDeps {
  now: () => number;
  delay: (ms: number, signal?: AbortSignal) => Promise<void>;
  render: (line: string) => void;
}

const TICK_MS = 1_000;

const DEFAULT_DEPS: WaitDeps = {
  now: () => Date.now(),
  delay: (ms, signal) => cancellableDelay(ms, signal),
  render: (line) => {
    // Rewrite the current TTY line in place.
    process.stdout.write(`\r${line}`);
  },
};

export async function waitForSchedule(
  target: Date,
  opts: { label: string; headless: boolean; signal: AbortSignal; _deps?: Partial<WaitDeps> },
): Promise<WaitOutcome> {
  const deps: WaitDeps = { ...DEFAULT_DEPS, ...opts._deps };
  const targetMs = target.getTime();

  while (deps.now() < targetMs) {
    if (opts.signal.aborted) return "cancelled";
    const remaining = targetMs - deps.now();
    if (!opts.headless) {
      deps.render(
        `⏳ Scheduled run of "${opts.label}" — starting in ${formatRemaining(remaining)}   (Ctrl-C to cancel)`,
      );
    }
    const wait = Math.min(TICK_MS, remaining);
    try {
      await deps.delay(wait, opts.signal);
    } catch {
      return "cancelled"; // delay rejects on abort
    }
  }

  if (!opts.headless) deps.render("\n"); // clear the countdown line before run output
  return "fired";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 15 bun test test/unit/schedule/wait.test.ts --timeout=5000`
Expected: PASS (fires, cancels, headless-silent).

- [ ] **Step 5: Run the full schedule suite**

Run: `timeout 20 bun test test/unit/schedule/ --timeout=5000`
Expected: PASS — parse, format, wait all green.

- [ ] **Step 6: Commit**

```bash
git add src/schedule/wait.ts src/schedule/index.ts test/unit/schedule/wait.test.ts
git commit -m "feat(schedule): add waitForSchedule countdown gate with cancellation"
```

---

## Task 6: CLI wiring — `--schedule` flag, fail-fast parse, gate before run

**Files:**
- Modify: `bin/nax.ts` (run command: option block ~365-390; gate before `run({...})` at ~641)
- Test: `test/unit/cli/schedule-flag.test.ts`

**Interfaces:**
- Consumes: `parseSchedule`, `waitForSchedule` from `@/schedule`; `NaxError` from `@/errors` (or relative `../src/errors`).
- Produces: user-facing CLI behavior. Extract the gate into a small exported helper so it is unit-testable without spawning nax.

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/cli/schedule-flag.test.ts
import { describe, expect, test } from "bun:test";
import { resolveScheduleGate } from "@/schedule";

const NOW = new Date("2026-07-01T12:00:00");

describe("resolveScheduleGate", () => {
  test("undefined schedule → run immediately, no target", () => {
    const r = resolveScheduleGate(undefined, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target).toBeNull();
  });

  test("valid relative schedule → target set", () => {
    const r = resolveScheduleGate("30m", NOW);
    expect(r.ok).toBe(true);
    if (r.ok && r.target) expect(r.target.getTime()).toBe(NOW.getTime() + 30 * 60_000);
  });

  test("invalid schedule → error", () => {
    const r = resolveScheduleGate("nonsense", NOW);
    expect(r.ok).toBe(false);
  });

  test("past absolute → error", () => {
    const r = resolveScheduleGate("2026-06-01T00:00", NOW);
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 15 bun test test/unit/cli/schedule-flag.test.ts --timeout=5000`
Expected: FAIL — `resolveScheduleGate` not exported.

- [ ] **Step 3: Write minimal implementation — helper**

```typescript
// src/schedule/parse.ts — add (keeps CLI thin, reuses parseSchedule)
export type ScheduleGateResult =
  | { ok: true; target: Date | null }
  | { ok: false; error: string };

export function resolveScheduleGate(input: string | undefined, now: Date): ScheduleGateResult {
  if (input === undefined) return { ok: true, target: null };
  const parsed = parseSchedule(input, now);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, target: parsed.target };
}
```

```typescript
// src/schedule/index.ts — add
export { resolveScheduleGate } from "./parse";
export type { ScheduleGateResult } from "./parse";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `timeout 15 bun test test/unit/cli/schedule-flag.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Wire into `bin/nax.ts`**

Add the option in the `run` command builder (after the `--profile` option, before `.action`):

```typescript
  .option(
    "--schedule <when>",
    "Defer run start until <when> (e.g. 30m, 1h30m, 17:00, 2026-07-02T02:00)",
  )
```

Add imports near the other `../src/...` imports at the top of `bin/nax.ts`:

```typescript
import { resolveScheduleGate, waitForSchedule } from "../src/schedule";
```

Parse the flag early — inside the `run` action, right after the existing `validateDirectory` block (fail fast before any expensive work):

```typescript
    // Parse --schedule early so a bad value errors before any setup.
    const scheduleGate = resolveScheduleGate(options.schedule, new Date());
    if (!scheduleGate.ok) {
      console.error(chalk.red(`Invalid --schedule: ${scheduleGate.error}`));
      process.exit(1);
    }
```

Perform the wait immediately before the `const result = await run({...})` call (~line 641):

```typescript
    if (scheduleGate.target) {
      const scheduleController = new AbortController();
      const onSigint = () => scheduleController.abort();
      process.once("SIGINT", onSigint);
      const outcome = await waitForSchedule(scheduleGate.target, {
        label: options.feature,
        headless: useHeadless || formatterMode === "json",
        signal: scheduleController.signal,
      });
      process.removeListener("SIGINT", onSigint);
      if (outcome === "cancelled") {
        console.log(chalk.dim("\nScheduled run cancelled."));
        process.exit(0);
      }
    }
```

- [ ] **Step 6: Typecheck + lint**

Run: `bun run typecheck && bun x biome check src/schedule bin/nax.ts`
Expected: no errors.

- [ ] **Step 7: Manual smoke test**

Run: `bun run bin/nax.ts run -f nonexistent --schedule 3s --dir /tmp 2>&1 | head -5`
Expected: either a fast countdown then the normal "nax not initialized"/PRD error, or the schedule error if the value were bad — confirming the gate fires and hands off. (Use a real initialized feature dir for a full end-to-end check.)

Run: `bun run bin/nax.ts run -f whatever --schedule bogus 2>&1 | head -2`
Expected: `Invalid --schedule: Unrecognized schedule "bogus". ...`, exit 1.

- [ ] **Step 8: Commit**

```bash
git add src/schedule/parse.ts src/schedule/index.ts bin/nax.ts test/unit/cli/schedule-flag.test.ts
git commit -m "feat(schedule): wire --schedule flag into nax run with countdown gate"
```

---

## Task 7: Full-suite gate + docs note

**Files:**
- Modify: `docs/superpowers/specs/2026-07-01-scheduled-run-design.md` (mark Status: Implemented) — optional
- No new code.

- [ ] **Step 1: Run the schedule + CLI unit suites**

Run: `timeout 30 bun test test/unit/schedule/ test/unit/cli/schedule-flag.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 2: Run typecheck + lint (file-size + alias checks included)**

Run: `bun run typecheck && bun run lint`
Expected: no errors; `src/schedule/*` under size limits; barrel imports clean.

- [ ] **Step 3: Run the full unit suite as a regression gate**

Run: `bun run test:bail`
Expected: PASS (no regressions from the `bin/nax.ts` edit).

- [ ] **Step 4: Commit any doc status change**

```bash
git add docs/superpowers/specs/2026-07-01-scheduled-run-design.md
git commit -m "docs(schedule): mark scheduled-run spec implemented"
```

---

## Self-Review

**Spec coverage:**
- Grammar (relative / time-of-day / ISO) → Tasks 1, 2, 3. ✓
- Roll-to-tomorrow, past-error, date-only reject, local tz → Tasks 2, 3. ✓
- Countdown display + `HH:MM:SS` → Tasks 4, 5. ✓
- Cancellation (Ctrl-C) → Task 5 (signal) + Task 6 (SIGINT wiring). ✓
- Headless/JSON suppression → Task 5 (`headless` flag) + Task 6 (`headless || json`). ✓
- Fail-fast placement before `run()` → Task 6. ✓
- DI/testability (`_deps`, fake clock, pure parser) → Tasks 1–5. ✓
- Barrel `src/schedule/index.ts` → Tasks 1, 4, 5, 6. ✓
- Reuse `cancellableDelay`, `NaxError` → Tasks 5, 6. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `ScheduleParseResult` (`{ok,target}|{ok,error}`) used consistently across Tasks 1–3; `WaitOutcome`/`WaitDeps` defined in Task 5 and consumed in Task 6; `resolveScheduleGate` returns `ScheduleGateResult` used identically in the CLI test and wiring. ✓

**Note on Task 4/5 export coupling:** Task 4's barrel line references `waitForSchedule` (added in Task 5). If executing tasks in strict isolation, export only `formatRemaining` in Task 4 and add the rest in Task 5 (flagged inline). Sequential execution is unaffected.
