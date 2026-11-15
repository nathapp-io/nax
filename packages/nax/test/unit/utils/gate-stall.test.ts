import { describe, expect, test } from "bun:test";
import { type FakeClock, makeFakeClock } from "@test/helpers";
import {
  createGateStallMonitor,
  DEFAULT_GATE_STALL_POLICY,
  type GateStallPolicy,
  type GateStopReason,
  resolveStallDetection,
} from "@/utils/gate-stall";

const encoder = new TextEncoder();

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

/** The monitor's timer seam, adapted to a FakeClock without a cast. */
type TimerSeam = {
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
};

function timersOf(clock: FakeClock): TimerSeam {
  return {
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (handle) => {
      if (typeof handle === "number") clock.clearTimeout(handle);
    },
  };
}

/** A monitor wired to a virtual clock, capturing every stop reason it emits. */
function harness(policy: Partial<GateStallPolicy> = {}) {
  const clock = makeFakeClock();
  const stops: GateStopReason[] = [];
  const monitor = createGateStallMonitor({
    policy: { ...DEFAULT_GATE_STALL_POLICY, ...policy },
    onStop: (reason) => stops.push(reason),
    ...timersOf(clock),
  });
  return { clock, monitor, stops };
}

const REPEAT = (repeatedLineThreshold: number): Partial<GateStallPolicy> => ({
  repeatedLineThreshold,
  silenceTimeoutSeconds: 0,
});

const SILENCE = (silenceTimeoutSeconds: number): Partial<GateStallPolicy> => ({
  repeatedLineThreshold: 0,
  silenceTimeoutSeconds,
});

describe("createGateStallMonitor — repeated output", () => {
  test("emits repeated-output on the Nth consecutive equal line, counting the first as 1", () => {
    // AC-1
    const { monitor, stops } = harness(REPEAT(3));

    monitor.observe("stdout", bytes("boom\n"));
    monitor.observe("stdout", bytes("boom\n"));
    expect(stops).toEqual([]);

    monitor.observe("stdout", bytes("boom\n"));
    expect(stops).toEqual([{ kind: "repeated-output", stream: "stdout", count: 3, threshold: 3 }]);
  });

  test("keeps stdout and stderr repetition counts independent under interleaved identical text", () => {
    // AC-2
    const { monitor, stops } = harness(REPEAT(3));

    monitor.observe("stdout", bytes("same\n"));
    monitor.observe("stderr", bytes("same\n"));
    monitor.observe("stdout", bytes("same\n"));
    monitor.observe("stderr", bytes("same\n"));
    // Four identical lines overall; a shared counter would already have fired.
    expect(stops).toEqual([]);

    monitor.observe("stdout", bytes("same\n"));
    expect(stops).toEqual([{ kind: "repeated-output", stream: "stdout", count: 3, threshold: 3 }]);
  });

  test("activity on the other stream does not reset a stream's run", () => {
    // AC-2 (second effect of the same mechanism)
    const { monitor, stops } = harness(REPEAT(3));

    monitor.observe("stdout", bytes("loop\n"));
    monitor.observe("stderr", bytes("noise\n"));
    monitor.observe("stdout", bytes("loop\n"));
    monitor.observe("stderr", bytes("other\n"));
    monitor.observe("stdout", bytes("loop\n"));

    expect(stops).toEqual([{ kind: "repeated-output", stream: "stdout", count: 3, threshold: 3 }]);
  });

  test("a different eligible line restarts the count at 1", () => {
    // AC-3
    const { monitor, stops } = harness(REPEAT(3));

    monitor.observe("stdout", bytes("a\n"));
    monitor.observe("stdout", bytes("a\n"));
    monitor.observe("stdout", bytes("b\n"));
    monitor.observe("stdout", bytes("a\n"));
    monitor.observe("stdout", bytes("a\n"));
    expect(stops).toEqual([]);

    monitor.observe("stdout", bytes("a\n"));
    expect(stops).toEqual([{ kind: "repeated-output", stream: "stdout", count: 3, threshold: 3 }]);
  });

  test("a whitespace-only line resets the count", () => {
    // AC-4
    const { monitor, stops } = harness(REPEAT(3));

    monitor.observe("stdout", bytes("a\n"));
    monitor.observe("stdout", bytes("a\n"));
    monitor.observe("stdout", bytes("   \n"));
    monitor.observe("stdout", bytes("a\n"));
    monitor.observe("stdout", bytes("a\n"));
    expect(stops).toEqual([]);

    monitor.observe("stdout", bytes("a\n"));
    expect(stops).toEqual([{ kind: "repeated-output", stream: "stdout", count: 3, threshold: 3 }]);
  });

  test("never counts a whitespace-only line toward a stop", () => {
    // AC-5
    const { monitor, stops } = harness(REPEAT(2));

    for (let i = 0; i < 10; i++) {
      monitor.observe("stdout", bytes("   \n"));
      monitor.observe("stderr", bytes("\t\n"));
    }

    expect(stops).toEqual([]);
  });

  test("compares decoded text exactly: indentation, trailing spaces, case and ANSI differ", () => {
    // AC-6
    const { monitor, stops } = harness(REPEAT(2));
    const distinct = ["a", " a", "a ", "A", "\u001b[31ma\u001b[0m", "\u001b[32ma\u001b[0m"];

    for (const line of distinct) monitor.observe("stdout", bytes(`${line}\n`));
    expect(stops).toEqual([]);

    monitor.observe("stdout", bytes(`${distinct[distinct.length - 1]}\n`));
    expect(stops).toEqual([{ kind: "repeated-output", stream: "stdout", count: 2, threshold: 2 }]);
  });
});

describe("createGateStallMonitor — decoding and delimiters", () => {
  /** Replay `content` through `monitor` in chunks of the given sizes (cycled). */
  function feedChunks(monitor: ReturnType<typeof harness>["monitor"], content: string, sizes: readonly number[]): void {
    const all = bytes(content);
    let offset = 0;
    let index = 0;
    while (offset < all.length) {
      const size = sizes[index % sizes.length] ?? 1;
      monitor.observe("stdout", all.subarray(offset, offset + size));
      offset += size;
      index++;
    }
  }

  test("produces the same line decisions for arbitrarily split UTF-8 as for unsplit input", () => {
    // AC-7
    const content = "é日\u{1f600} done\n".repeat(3);
    const whole = harness(REPEAT(3));
    feedChunks(whole.monitor, content, [content.length]);
    const split = harness(REPEAT(3));
    feedChunks(split.monitor, content, [1, 2, 3, 5, 1, 7]);

    expect(split.stops).toEqual(whole.stops);
    expect(whole.stops).toEqual([{ kind: "repeated-output", stream: "stdout", count: 3, threshold: 3 }]);
  });

  test("decodes a split multibyte sequence to the same text as an unsplit one", () => {
    // AC-7 (a per-chunk decode would yield replacement characters and never match)
    const { monitor, stops } = harness(REPEAT(2));
    const encoded = bytes("é\n");
    monitor.observe("stdout", encoded.subarray(0, 1));
    monitor.observe("stdout", encoded.subarray(1));
    monitor.observe("stdout", bytes("é\n"));

    expect(stops).toEqual([{ kind: "repeated-output", stream: "stdout", count: 2, threshold: 2 }]);
  });

  test("treats a CRLF delimiter split across chunks as one delimiter", () => {
    // AC-8
    const { monitor, stops } = harness(REPEAT(2));

    monitor.observe("stdout", bytes("line one\r"));
    monitor.observe("stdout", bytes("\nline one\r"));
    expect(stops).toEqual([]);

    monitor.observe("stdout", bytes("\n"));
    expect(stops).toEqual([{ kind: "repeated-output", stream: "stdout", count: 2, threshold: 2 }]);
  });

  test("treats LF as the line end", () => {
    // AC-8
    const { monitor, stops } = harness(REPEAT(2));
    monitor.observe("stdout", bytes("abc\nab"));
    monitor.observe("stdout", bytes("c\n"));

    expect(stops).toEqual([{ kind: "repeated-output", stream: "stdout", count: 2, threshold: 2 }]);
  });

  test("treats a bare CR as ordinary content, not a delimiter", () => {
    // AC-9
    const carriageOnly = harness(REPEAT(2));
    for (let i = 0; i < 10; i++) carriageOnly.monitor.observe("stdout", bytes("progress 1%\r"));
    expect(carriageOnly.stops).toEqual([]);

    const mixed = harness(REPEAT(2));
    mixed.monitor.observe("stdout", bytes("a\rb\n"));
    mixed.monitor.observe("stdout", bytes("a\rb\n"));
    expect(mixed.stops).toEqual([{ kind: "repeated-output", stream: "stdout", count: 2, threshold: 2 }]);
  });

  test("end treats a nonempty unterminated tail as one final line while live", () => {
    // AC-10
    const { monitor, stops } = harness(REPEAT(2));
    monitor.observe("stdout", bytes("tail\ntail"));
    expect(stops).toEqual([]);

    monitor.end("stdout");
    expect(stops).toEqual([{ kind: "repeated-output", stream: "stdout", count: 2, threshold: 2 }]);
  });
});

describe("createGateStallMonitor — overlong line bound", () => {
  const CAP = 16_384;

  test("ignores an overlong line through its delimiter instead of matching a truncated prefix", () => {
    // AC-11
    const { monitor, stops } = harness(REPEAT(2));

    monitor.observe("stdout", bytes(`${"z".repeat(CAP + 1)}\n`));
    monitor.observe("stdout", bytes(`${"z".repeat(CAP)}y\n`));
    // A truncated-prefix match would compare two CAP-length "z" runs and fire.
    expect(stops).toEqual([]);
  });

  test("an overlong line resets the run", () => {
    // AC-11
    const { monitor, stops } = harness(REPEAT(2));
    monitor.observe("stdout", bytes("a\n"));
    monitor.observe("stdout", bytes(`${"x".repeat(CAP + 5)}\n`));
    monitor.observe("stdout", bytes("a\n"));

    expect(stops).toEqual([]);
  });

  test("an overlong line delivered in pieces is dropped as it grows", () => {
    // AC-11 — the pending-buffer bound is only reached by streaming input
    const { monitor, stops } = harness(REPEAT(2));
    const chunk = bytes("w".repeat(4_096));
    const overlong = () => {
      for (let i = 0; i < 5; i++) monitor.observe("stdout", chunk);
      monitor.observe("stdout", bytes("\n"));
    };

    overlong();
    overlong();

    expect(stops).toEqual([]);
  });

  test("a line of exactly the cap terminated by a CRLF delimiter is not overlong", () => {
    // AC-11 (F1) — the CR belongs to the delimiter, so it must not count
    // toward the cap. An accepted cap-length line consumes the whole per-stream
    // budget, so the very next line cannot be assembled and is dropped; that is
    // how acceptance is observable through the stop payload.
    for (const chunks of [[`${"c".repeat(CAP)}\r\n`], [`${"c".repeat(CAP)}\r`, "\n"]]) {
      const { monitor, stops } = harness(REPEAT(2));
      for (const chunk of chunks) monitor.observe("stdout", bytes(chunk));

      monitor.observe("stdout", bytes("tiny\n"));
      monitor.observe("stdout", bytes("tiny\n"));
      expect(stops).toEqual([]);

      monitor.observe("stdout", bytes("tiny\n"));
      expect(stops).toEqual([{ kind: "repeated-output", stream: "stdout", count: 2, threshold: 2 }]);
    }
  });

  test("the cap is shared between the pending line and the previous line", () => {
    // AC-11 (F2) — retained detector text per stream never exceeds the cap.
    const fits = harness(REPEAT(2));
    fits.monitor.observe("stdout", bytes(`${"f".repeat(8_000)}\n`));
    fits.monitor.observe("stdout", bytes(`${"f".repeat(8_000)}\n`));
    expect(fits.stops).toEqual([{ kind: "repeated-output", stream: "stdout", count: 2, threshold: 2 }]);

    const exceeds = harness(REPEAT(2));
    exceeds.monitor.observe("stdout", bytes(`${"e".repeat(9_000)}\n`));
    exceeds.monitor.observe("stdout", bytes(`${"e".repeat(9_000)}\n`));
    // 9,000 + 9,000 is over the per-stream bound, so the second line is dropped
    // as overlong rather than retained alongside the first.
    expect(exceeds.stops).toEqual([]);
  });

  test("a trailing CR at EOF is content, so it can push the tail over the bound", () => {
    // AC-11 — with no LF, a CR is not a delimiter
    const { monitor, stops } = harness(REPEAT(2));
    monitor.observe("stdout", bytes("ab\n"));
    monitor.observe("stdout", bytes(`${"c".repeat(16_382)}\r`));
    monitor.end("stdout");

    expect(stops).toEqual([]);
  });
});

describe("createGateStallMonitor — silence", () => {
  test("emits silence after the configured seconds without nonempty bytes since spawn", async () => {
    // AC-12
    const { clock, monitor, stops } = harness(SILENCE(2));

    await clock.advance(1_999);
    expect(stops).toEqual([]);

    await clock.advance(1);
    expect(stops).toEqual([{ kind: "silence", silenceTimeoutSeconds: 2 }]);
    monitor.dispose();
  });

  test("resets silence on a nonempty chunk on either stream, including blank and partial lines", async () => {
    // AC-13
    const { clock, monitor, stops } = harness(SILENCE(2));

    await clock.advance(1_500);
    monitor.observe("stdout", bytes("\n"));
    await clock.advance(1_500);
    expect(stops).toEqual([]);

    monitor.observe("stderr", bytes("partial line, no delimiter"));
    await clock.advance(1_500);
    expect(stops).toEqual([]);

    monitor.observe("stdout", bytes(" "));
    await clock.advance(1_999);
    expect(stops).toEqual([]);

    await clock.advance(1);
    expect(stops).toEqual([{ kind: "silence", silenceTimeoutSeconds: 2 }]);
  });

  test("does not reset silence on an empty chunk", async () => {
    // AC-14
    const { clock, monitor, stops } = harness(SILENCE(2));

    await clock.advance(1_000);
    monitor.observe("stdout", new Uint8Array(0));
    monitor.observe("stderr", new Uint8Array(0));
    await clock.advance(1_000);

    expect(stops).toEqual([{ kind: "silence", silenceTimeoutSeconds: 2 }]);
  });

  test("does not reset silence at stream EOF", async () => {
    // AC-15
    const { clock, monitor, stops } = harness(SILENCE(2));

    await clock.advance(1_000);
    monitor.end("stdout");
    monitor.end("stderr");
    await clock.advance(1_000);

    expect(stops).toEqual([{ kind: "silence", silenceTimeoutSeconds: 2 }]);
  });
});

describe("createGateStallMonitor — disabled policy and interaction", () => {
  test("a fully zero policy emits no stop while fake time advances and repeated lines arrive", async () => {
    // AC-16
    const { clock, monitor, stops } = harness({ repeatedLineThreshold: 0, silenceTimeoutSeconds: 0 });
    expect(clock.pending()).toBe(0);

    for (let i = 0; i < 200; i++) monitor.observe("stdout", bytes("spam\n"));
    await clock.advance(100_000);

    expect(stops).toEqual([]);
    monitor.dispose();
  });

  test("repeated lines arriving before each silence deadline stop for repeated-output", async () => {
    // AC-17
    const { clock, monitor, stops } = harness({ repeatedLineThreshold: 3, silenceTimeoutSeconds: 5 });

    monitor.observe("stdout", bytes("x\n"));
    await clock.advance(1_000);
    monitor.observe("stdout", bytes("x\n"));
    await clock.advance(1_000);
    monitor.observe("stdout", bytes("x\n"));

    // Fires inside the 5s silence window, so repetition was not deferred to it.
    expect(stops).toEqual([{ kind: "repeated-output", stream: "stdout", count: 3, threshold: 3 }]);

    await clock.advance(10_000);
    expect(stops).toHaveLength(1);
    expect(stops[0]?.kind).toBe("repeated-output");
  });
});

describe("createGateStallMonitor — lifecycle", () => {
  test("dispose prevents later callbacks from emitting a stop", async () => {
    // AC-18
    const { clock, monitor, stops } = harness({ repeatedLineThreshold: 3, silenceTimeoutSeconds: 2 });

    await clock.advance(1_000);
    monitor.dispose();

    await clock.advance(10_000);
    for (let i = 0; i < 5; i++) monitor.observe("stdout", bytes("y\n"));
    monitor.end("stdout");

    expect(stops).toEqual([]);
  });

  test("dispose leaves no active silence timer", () => {
    // AC-19
    const { clock, monitor } = harness(SILENCE(2));
    expect(clock.pending()).toBe(1);

    monitor.dispose();
    expect(clock.pending()).toBe(0);
  });

  test("two instances keep isolated counters and silence deadlines when interleaved", async () => {
    // AC-20
    const clock = makeFakeClock();
    const make = (policy: Partial<GateStallPolicy>) => {
      const stops: GateStopReason[] = [];
      const monitor = createGateStallMonitor({
        policy: { ...DEFAULT_GATE_STALL_POLICY, ...policy },
        onStop: (reason) => stops.push(reason),
        ...timersOf(clock),
      });
      return { monitor, stops };
    };

    const first = make(REPEAT(2));
    const second = make(REPEAT(2));
    first.monitor.observe("stdout", bytes("a\n"));
    second.monitor.observe("stdout", bytes("a\n"));
    expect(first.stops).toEqual([]);
    expect(second.stops).toEqual([]);

    first.monitor.observe("stdout", bytes("a\n"));
    expect(first.stops).toEqual([{ kind: "repeated-output", stream: "stdout", count: 2, threshold: 2 }]);
    expect(second.stops).toEqual([]);

    second.monitor.observe("stdout", bytes("a\n"));
    expect(second.stops).toEqual([{ kind: "repeated-output", stream: "stdout", count: 2, threshold: 2 }]);

    const silentOne = make(SILENCE(4));
    const silentTwo = make(SILENCE(4));
    silentOne.monitor.observe("stdout", bytes("x"));
    silentTwo.monitor.observe("stdout", bytes("x"));
    await clock.advance(3_000);
    silentOne.monitor.observe("stdout", bytes("y"));

    await clock.advance(1_000);
    expect(silentTwo.stops).toEqual([{ kind: "silence", silenceTimeoutSeconds: 4 }]);
    expect(silentOne.stops).toEqual([]);

    await clock.advance(3_000);
    expect(silentOne.stops).toEqual([{ kind: "silence", silenceTimeoutSeconds: 4 }]);
  });
});

describe("createGateStallMonitor — a silence deadline beyond the timer range", () => {
  // Whole-branch review B2: Bun (like Node) substitutes ~1 ms and warns for a
  // delay above 2^31-1 ms, so a supported multi-week silence threshold used to
  // stop a gate immediately. Every armed delay must stay in range while the
  // slices still add up to the configured deadline.
  const MAX_DELAY_MS = 2_147_483_647;
  /** 3,000,000 s — a supported value, and well past the single-timer range. */
  const LONG_SECONDS = 3_000_000;

  /** The monitor with its timer delays recorded, so an overflow is observable. */
  function recordingHarness(policy: Partial<GateStallPolicy>) {
    const clock = makeFakeClock();
    const stops: GateStopReason[] = [];
    const delays: number[] = [];
    const monitor = createGateStallMonitor({
      policy: { ...DEFAULT_GATE_STALL_POLICY, ...policy },
      onStop: (reason) => stops.push(reason),
      setTimeout: (fn, ms) => {
        delays.push(ms);
        return clock.setTimeout(fn, ms);
      },
      clearTimeout: (handle) => {
        if (typeof handle === "number") clock.clearTimeout(handle);
      },
    });
    return { clock, monitor, stops, delays };
  }

  test("arms every slice inside the timer range instead of stopping at 1 ms", async () => {
    const { clock, monitor, stops, delays } = recordingHarness(SILENCE(LONG_SECONDS));

    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeLessThanOrEqual(MAX_DELAY_MS);

    // Bun's overflow substitution would fire the deadline on the next millisecond.
    await clock.advance(1);
    expect(stops).toEqual([]);

    // The slices add up to the configured deadline: silent one millisecond before it…
    await clock.advance(LONG_SECONDS * 1_000 - 2);
    expect(stops).toEqual([]);
    // …and stopped at it.
    await clock.advance(1);
    expect(stops).toEqual([{ kind: "silence", silenceTimeoutSeconds: LONG_SECONDS }]);
    expect(delays.every((ms) => ms > 0 && ms <= MAX_DELAY_MS)).toBe(true);
    monitor.dispose();
  });

  test("a deadline exactly at the boundary stays one timer", async () => {
    // 2,147,483 s is the largest whole-second deadline that fits 2^31-1 ms.
    const atBoundary = recordingHarness(SILENCE(2_147_483));
    expect(atBoundary.delays).toEqual([2_147_483_000]);
    atBoundary.monitor.dispose();

    const pastBoundary = recordingHarness(SILENCE(2_147_484));
    expect(pastBoundary.delays).toEqual([MAX_DELAY_MS]);
    pastBoundary.monitor.dispose();
  });

  test("a chunk restarts the whole sliced deadline from the configured value", async () => {
    const { clock, monitor, stops, delays } = recordingHarness(SILENCE(LONG_SECONDS));

    await clock.advance(MAX_DELAY_MS - 1_000);
    monitor.observe("stdout", bytes("still working\n"));
    // Reset: the remainder of the first slice is discarded and the full deadline
    // is armed again, still in range.
    expect(delays).toHaveLength(2);
    expect(delays[1]).toBeLessThanOrEqual(MAX_DELAY_MS);

    // The pre-reset deadline would have passed if the chain had not restarted:
    // one millisecond before the full span counted from the reset, still silent…
    await clock.advance(LONG_SECONDS * 1_000 - 1);
    expect(stops).toEqual([]);
    // …and stopped at it.
    await clock.advance(1);
    expect(stops).toEqual([{ kind: "silence", silenceTimeoutSeconds: LONG_SECONDS }]);
    expect(delays.every((ms) => ms > 0 && ms <= MAX_DELAY_MS)).toBe(true);
    monitor.dispose();
  });

  test("dispose cancels the pending slice of a sliced deadline", async () => {
    const { clock, monitor, stops } = recordingHarness(SILENCE(LONG_SECONDS));

    monitor.dispose();
    expect(clock.pending()).toBe(0);

    await clock.advance(LONG_SECONDS * 1_000);
    expect(stops).toEqual([]);
  });
});

describe("resolveStallDetection", () => {
  test("fills an absent field from DEFAULT_GATE_STALL_POLICY", () => {
    // AC-21
    expect(DEFAULT_GATE_STALL_POLICY).toEqual({ repeatedLineThreshold: 100, silenceTimeoutSeconds: 0 });
    expect(resolveStallDetection()).toEqual({ repeatedLineThreshold: 100, silenceTimeoutSeconds: 0 });
    expect(resolveStallDetection({})).toEqual({ repeatedLineThreshold: 100, silenceTimeoutSeconds: 0 });
    expect(resolveStallDetection({ repeatedLineThreshold: 5 })).toEqual({
      repeatedLineThreshold: 5,
      silenceTimeoutSeconds: 0,
    });
    expect(resolveStallDetection({ silenceTimeoutSeconds: 7 })).toEqual({
      repeatedLineThreshold: 100,
      silenceTimeoutSeconds: 7,
    });
  });

  test("preserves an explicit zero", () => {
    // AC-21
    expect(resolveStallDetection({ repeatedLineThreshold: 0, silenceTimeoutSeconds: 0 })).toEqual({
      repeatedLineThreshold: 0,
      silenceTimeoutSeconds: 0,
    });
    expect(resolveStallDetection({ repeatedLineThreshold: 0 })).toEqual({
      repeatedLineThreshold: 0,
      silenceTimeoutSeconds: 0,
    });
  });
});
