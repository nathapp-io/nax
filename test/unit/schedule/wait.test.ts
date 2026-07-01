import { describe, expect, test } from "bun:test";
import { waitForSchedule } from "@/schedule";

function fakeDeps(startMs: number, stepMs: number) {
  let current = startMs;
  const lines: string[] = [];
  const logs: Array<{ message: string; data: Record<string, unknown> }> = [];
  return {
    lines,
    logs,
    deps: {
      now: () => current,
      // Each "delay" advances the fake clock by stepMs instead of waiting.
      delay: async (_ms: number, signal?: AbortSignal) => {
        if (signal?.aborted) throw new Error("aborted");
        current += stepMs;
      },
      render: (line: string) => lines.push(line),
      log: (message: string, data: Record<string, unknown>) => logs.push({ message, data }),
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

  test("headless emits exactly one structured log line with target ISO", async () => {
    const start = 1_000_000;
    const { lines, logs, deps } = fakeDeps(start, 5_000);
    const target = new Date(start + 3_000);
    const outcome = await waitForSchedule(target, {
      label: "feat-x",
      headless: true,
      signal: new AbortController().signal,
      _deps: deps,
    });
    expect(outcome).toBe("fired");
    expect(lines.length).toBe(0);              // still no render lines
    expect(logs.length).toBe(1);               // exactly one structured line
    expect(logs[0].data.targetIso).toBe(target.toISOString());
    expect(logs[0].data.label).toBe("feat-x");
  });
});
