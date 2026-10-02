import { getSafeLogger } from "@/logger";
import { cancellableDelay } from "@/utils/bun-deps";

export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export type WaitOutcome = "fired" | "cancelled";

export interface WaitDeps {
  now: () => number;
  delay: (ms: number, signal?: AbortSignal) => Promise<void>;
  render: (line: string) => void;
  log: (message: string, data: Record<string, unknown>) => void;
}

const TICK_MS = 1_000;

const DEFAULT_DEPS: WaitDeps = {
  now: () => Date.now(),
  delay: (ms, signal) => cancellableDelay(ms, signal),
  render: (line) => {
    // Rewrite the current TTY line in place.
    process.stdout.write(`\r${line}`);
  },
  log: (message, data) => getSafeLogger()?.info("schedule", message, data),
};

export async function waitForSchedule(
  target: Date,
  opts: { label: string; quiet: boolean; signal: AbortSignal; _deps?: Partial<WaitDeps> },
): Promise<WaitOutcome> {
  const deps: WaitDeps = { ...DEFAULT_DEPS, ...opts._deps };
  const targetMs = target.getTime();

  if (opts.quiet) {
    deps.log("Scheduled run waiting", { label: opts.label, targetIso: target.toISOString() });
  }

  while (deps.now() < targetMs) {
    if (opts.signal.aborted) return "cancelled";
    const remaining = targetMs - deps.now();
    if (!opts.quiet) {
      deps.render(
        `[WAIT] Scheduled run of "${opts.label}" — starting in ${formatRemaining(remaining)}   (Ctrl-C to cancel)`,
      );
    }
    const wait = Math.min(TICK_MS, remaining);
    try {
      await deps.delay(wait, opts.signal);
    } catch {
      return "cancelled"; // delay rejects on abort
    }
  }

  if (!opts.quiet) deps.render("\n"); // clear the countdown line before run output
  return "fired";
}
