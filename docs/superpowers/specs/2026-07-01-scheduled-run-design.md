# Scheduled Run (`nax run --schedule`) — Design

**Date:** 2026-07-01
**Status:** Implemented
**Scope:** Add a one-shot, foreground scheduled start to `nax run`.

## 1. Summary

Add a `--schedule <when>` flag to `nax run` that defers the start of an
orchestration run until a wall-clock trigger fires. While waiting, the command
holds the terminal and displays a live countdown; when the countdown reaches
zero, it hands off to the **exact** run path that exists today (`run({...})` at
`bin/nax.ts:641`). Ctrl-C during the wait cancels cleanly, before any run
starts.

This is deliberately the smallest thing that delivers "start my run later":
foreground only, one-shot only, no reboot survival.

## 2. Goals / Non-Goals

### Goals
- `nax run -f <feature> --schedule <when>` waits until `<when>`, shows a
  countdown, then runs normally.
- Support relative delays, time-of-day, and explicit ISO datetime.
- Fail fast: cheap validation (bad flags, nax not initialized, missing PRD,
  unparseable `--schedule`, past absolute time) surfaces **before** the wait —
  never after a 30-minute countdown.
- Deterministic, unit-testable time parsing decoupled from wall clock via `_deps`.

### Non-Goals (explicit YAGNI)
- **No recurring / cron.** One-shot only. (Deferred; the same flag can later
  accept a cron expression without breaking this design.)
- **No reboot survival.** No OS cron/launchd/systemd, no schedule store on disk.
  If the process dies, the schedule is gone.
- **No daemon.** No detached background process, no `nax schedule` subcommand,
  no PID tracking beyond what a run already does.
- **No queueing** of multiple features.

## 3. User Experience

```bash
nax run -f my-feature --schedule 30m       # fire in 30 minutes
nax run -f my-feature --schedule 1h30m     # fire in 90 minutes
nax run -f my-feature --schedule 17:00      # fire at 5pm local today (or tomorrow if past)
nax run -f my-feature --schedule 2026-07-02T02:00   # fire at that local instant
```

While waiting, a single self-updating line:

```
⏳ Scheduled run of "my-feature" — starting in 00:29:47   (Ctrl-C to cancel)
```

On zero, the line is cleared and the normal run output/TUI takes over. Ctrl-C
during the wait prints `Scheduled run cancelled.` and exits 0 without starting
a run.

`--schedule` composes with existing flags (`--plan`, `--parallel`, `--headless`,
`--profile`, …); it only gates *when* `run()` is called. In `--json` / headless
mode the countdown is suppressed — instead a single structured line is logged at
start (`scheduled`, target ISO) so machine consumers aren't fed a redraw loop.

## 4. Schedule Grammar

| Form | Example | Meaning |
|:--|:--|:--|
| Relative delay | `30m`, `2h`, `90s`, `1h30m` | now + duration |
| Time of day | `17:00`, `09:30` | that time **today** in machine-local tz; if already past, **roll to tomorrow** |
| ISO datetime | `2026-07-02T02:00` | that exact instant, **machine-local** unless an offset/`Z` is present |

### Edge rules (confirmed with user)
1. **Time-of-day already past today** → roll to tomorrow (do not error).
2. **Absolute time / ISO in the past** → error immediately with a clear message
   (never fire instantly — protects against typos).
3. **Timezone:** naive datetime = machine-local tz. Explicit offset/`Z` is
   honored. **Bare date-only (`2026-07-02`, no time) is rejected** with an
   actionable error (`specify a time, e.g. 2026-07-02T02:00`) — this sidesteps
   JavaScript's `new Date()` footgun where date-only strings parse as UTC but
   date-time strings parse as local. We never feed the raw string to `new Date()`
   for the naive case; we parse fields explicitly and construct local time.

Relative-duration grammar: one or more `<int><unit>` segments, units `s`/`m`/`h`
(optionally `d`), no whitespace, positive integers. Anything else → parse error
listing the accepted forms.

## 5. Architecture

Two new, small, independently testable units plus a thin wiring change in the
CLI. All prompt/LLM concerns are untouched.

### 5.1 `src/schedule/parse.ts` — pure parser
```
parseSchedule(input: string, now: Date): { target: Date } | { error: string }
```
- Pure function of `(input, now)`. No `Date.now()` inside — `now` is injected,
  making every case (relative, roll-to-tomorrow, past-error, tz) a deterministic
  unit test with a fixed `now`.
- Returns a discriminated union (parsed target vs. structured error string) —
  matches the repo's "return validation results, don't throw for expected bad
  input" convention. Truly exceptional states are not expected here.
- Dispatches by shape: duration regex → relative; `HH:MM` → time-of-day;
  otherwise → ISO path (with the date-only rejection and offset handling above).

### 5.2 `src/schedule/wait.ts` — countdown gate
```
waitForSchedule(target: Date, opts: {
  label: string;
  headless: boolean;
  render?: (line: string) => void;   // _deps: default writes/clears a TTY line
  clock?: () => number;              // _deps: default Date.now
  sleep?: (ms, signal) => Promise;   // _deps: default cancellable Bun.sleep
  signal: AbortSignal;               // Ctrl-C
}): Promise<"fired" | "cancelled">
```
- Loops on a tick (≈1s), recomputes `target − clock()`, renders `HH:MM:SS`
  remaining. On `≤0` resolves `"fired"`. On abort resolves `"cancelled"`.
- **No `setInterval`.** Uses cancellable `Bun.sleep(tickMs, { signal })` per the
  Bun-native rule; the `setTimeout`+`clearTimeout` exception is unnecessary here.
- Headless/JSON: skip the render loop, emit one structured `scheduled` log line
  via the project logger, then a single cancellable sleep to target.
- `render`/`clock`/`sleep` are injected (`_deps` pattern) so the tick loop is
  unit-tested with a fake clock and a captured render buffer — no real waiting.

### 5.3 CLI wiring — `bin/nax.ts` run action
- New commander option:
  `.option("--schedule <when>", "Defer run start until <when> (e.g. 30m, 17:00, ISO datetime)")`
- Placement of the gate (critical for fail-fast): **after** the cheap
  validations already in the action (directory validation, `--plan/--from`
  checks, nax-init check, PRD-exists check, `--parallel` parse) and **before**
  TUI construction and the `run({...})` call at line 641. Concretely: parse
  `--schedule` up front (so a bad value errors instantly), but perform the
  actual *wait* right before `run()`, once we already know the run is viable.
- Wire an `AbortController` to `SIGINT` for the wait window only; after `run()`
  begins, the existing run/TUI signal handling owns Ctrl-C as it does today.
- If `waitForSchedule` returns `"cancelled"`, print the cancel notice and
  `process.exit(0)` without calling `run()`.

### 5.4 Barrel + module layout
- New dir `src/schedule/` with `index.ts` (barrel), `parse.ts`, `wait.ts`,
  `types.ts`. Consumers import from `@/schedule` (barrel rule). Files well under
  the 600-line limit.

## 6. Data Flow

```
nax run -f F --schedule 30m
  → commander parses flags
  → [cheap validation: dir, plan/from, nax-init, prd exists]           (fail fast)
  → parseSchedule("30m", now)                                          (fail fast on bad value / past time)
       → { target }  |  { error }→ print + exit 1
  → [existing setup up to just before run(): config, hooks, statusFile]
  → waitForSchedule(target, { label:F, headless, signal })            (countdown OR structured log)
       → "cancelled" → print notice, exit 0
       → "fired"     ↓
  → run({ prdPath, workdir, config, … })                              (UNCHANGED existing path)
```

## 7. Error Handling

- Parser errors → `NaxError` code `SCHEDULE_INVALID` at the CLI boundary, printed
  in red with the accepted-forms hint, `exit 1`. (CLI surfaces the message; the
  parser itself returns the structured error string — no throw for expected bad
  input.)
- Past absolute time → same path, message names the offending instant.
- Ctrl-C during wait → clean `exit 0`, no run, no partial artifacts (nothing has
  been created yet — the gate is before run setup that writes state).
- Everything downstream of `run()` keeps its current error handling verbatim.

## 8. Testing Plan

Unit (`test/unit/schedule/`), following `_deps` mocking + `test.each`:
- **parse.test.ts** — table-driven over `(input, now) → expected target|error`:
  relative single/compound units; `HH:MM` future vs. past-today (roll); ISO
  local; ISO with `Z`/offset; date-only rejection; past-instant error; garbage
  input; boundary (`0s`, huge durations).
- **wait.test.ts** — fake `clock` + captured `render`: countdown formats
  `HH:MM:SS` correctly; resolves `"fired"` at zero; resolves `"cancelled"` on
  abort mid-wait; headless path emits exactly one structured line and no render
  loop.
- **CLI integration** (light, mock the run path): `--schedule` with a near-future
  value calls `run()` once after the gate; bad value exits 1 before `run()`;
  cancel exits 0 without `run()`. Mock `run` — do not spawn a real nax process
  (per forbidden-patterns).

Coverage target: the two `src/schedule/` modules ≥ 80% (they're pure/DI, so
100% is realistic).

## 9. Alternatives Considered

- **Detached daemon + `~/.nax/schedules/` store** — survives terminal close.
  Rejected for v1: user explicitly does not need reboot survival, and the
  foreground `--schedule` UX (with countdown) was the user's own proposal.
  Several days of daemon lifecycle/PID work for little gain now.
- **Recurring cron in foreground** — would keep the process alive re-running
  forever. Rejected: awkward without reboot survival, and out of scope
  (one-shot only). The `--schedule` flag is forward-compatible with adding a
  cron form later.
- **Separate `nax schedule` subcommand** — more surface, duplicates the whole
  `run` flag set. Rejected in favor of a single flag on the existing command.

## 10. Open Questions

None blocking. Future extension seam noted: `parseSchedule` can grow a cron
branch returning a recurrence rather than a single `target`, and
`waitForSchedule` can loop, without changing the CLI contract.
