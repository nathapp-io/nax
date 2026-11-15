/**
 * Gate-stall leaf observer.
 *
 * Detects a harness gate command that has stopped making progress: either it is
 * repeating the same output line forever, or it has gone silent. Both are
 * observable long before the command's wall-clock limit, which otherwise stays
 * the only thing that ends a stuck run.
 *
 * This module is a LEAF: it imports nothing. It carries the policy/reason
 * types, the one default literal, the resolver and the per-spawn monitor.
 * `src/config/schemas-execution.ts` imports it for the defaults, which is why
 * the numbers exist exactly once.
 *
 * The monitor keeps its own state (decoder, pending line, repetition run) and
 * never touches captured output — a caller that also collects the stream keeps
 * collecting it, unabridged, whatever the detector decides.
 *
 * Per stream:
 *  - Incremental UTF-8 decoding survives split multibyte sequences and any
 *    chunk boundary.
 *  - LF ends a line, and a CR immediately before that LF is part of the same
 *    CRLF delimiter (so a CRLF split across chunks is one delimiter). A bare CR
 *    is ordinary content: progress-bar rewrites are not line breaks here.
 *  - Complete decoded line text is compared exactly, excluding its delimiter —
 *    indentation, trailing spaces, ANSI sequences and case all distinguish.
 *  - A whitespace-only line is ineligible: it resets the run and never counts.
 *  - Detector-only storage is bounded at LINE_CAP UTF-16 code units per stream,
 *    and the bound covers the pending line and the retained previous line
 *    TOGETHER: the pending line may only grow into what the previous line
 *    leaves. A line that does not fit is overlong — it resets the run and is
 *    ignored through its delimiter, so it can never match a truncated prefix.
 *    Delimiter bytes do not count: a trailing CR is not line text until the
 *    next byte proves it was not the first half of a CRLF.
 *  - Every nonempty chunk on either stream restarts the silence deadline.
 *    Empty chunks and EOF do not. Silence is measured from monitor creation,
 *    which is spawn time.
 *
 * Both detectors are disabled by their zero values, and `onStop` fires at most
 * once per monitor.
 */

/** Repetition/silence thresholds for one spawned gate command. */
export interface GateStallPolicy {
  /** 0 disables repetition detection. Otherwise the Nth consecutive equal line stops. */
  readonly repeatedLineThreshold: number;
  /** 0 disables silence detection. Otherwise seconds without any nonempty chunk. */
  readonly silenceTimeoutSeconds: number;
}

/** The single default literal; config schemas read its fields. */
export const DEFAULT_GATE_STALL_POLICY = {
  repeatedLineThreshold: 100,
  silenceTimeoutSeconds: 0,
} as const satisfies GateStallPolicy;

/** Why a live gate command was stopped by the detector. */
export type GateStopReason =
  | {
      readonly kind: "repeated-output";
      readonly stream: "stdout" | "stderr";
      readonly count: number;
      readonly threshold: number;
    }
  | { readonly kind: "silence"; readonly silenceTimeoutSeconds: number };

/** Per-spawn observation surface. All three methods are safe after a stop. */
export interface GateStallMonitor {
  observe(stream: "stdout" | "stderr", chunk: Uint8Array): void;
  end(stream: "stdout" | "stderr"): void;
  dispose(): void;
}

/** Detector-only line storage bound, in UTF-16 code units, per stream. */
const LINE_CAP = 16_384;

const MS_PER_SECOND = 1_000;

type StreamName = "stdout" | "stderr";

interface StreamState {
  readonly decoder: TextDecoder;
  /** Decoded text of the current, not-yet-terminated line. */
  pending: string;
  /** True while skipping the remainder of an overlong line, through its LF. */
  discarding: boolean;
  /** Previous eligible line, or null when no run is active. */
  lastLine: string | null;
  /** Length of the current consecutive run; the first occurrence is 1. */
  count: number;
}

export function createGateStallMonitor(options: {
  readonly policy: GateStallPolicy;
  readonly onStop: (reason: GateStopReason) => void;
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}): GateStallMonitor {
  const { policy, onStop, setTimeout: armTimer, clearTimeout: disarmTimer } = options;
  const silenceSeconds = policy.silenceTimeoutSeconds;
  let silenceHandle: unknown = null;
  let stopped = false;
  let disposed = false;

  function clearSilence(): void {
    if (silenceHandle === null) return;
    disarmTimer(silenceHandle);
    silenceHandle = null;
  }

  function emit(reason: GateStopReason): void {
    if (stopped || disposed) return;
    stopped = true;
    clearSilence();
    onStop(reason);
  }

  function armSilence(): void {
    clearSilence();
    if (disposed || stopped || silenceSeconds <= 0) return;
    silenceHandle = armTimer(() => {
      silenceHandle = null;
      emit({ kind: "silence", silenceTimeoutSeconds: silenceSeconds });
    }, silenceSeconds * MS_PER_SECOND);
  }

  const lines = createLineTracker({
    threshold: policy.repeatedLineThreshold,
    onRepeat: (stream, count) =>
      emit({ kind: "repeated-output", stream, count, threshold: policy.repeatedLineThreshold }),
  });

  function observe(stream: StreamName, chunk: Uint8Array): void {
    if (disposed || stopped) return;
    if (chunk.byteLength > 0) armSilence();
    lines.observe(stream, chunk);
  }

  function end(stream: StreamName): void {
    if (disposed || stopped) return;
    lines.end(stream);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    clearSilence();
  }

  // Silence is measured from spawn, so the deadline starts now, not at the
  // first byte.
  armSilence();

  return { observe, end, dispose };
}

/** Fill absent policy fields from the default, preserving an explicit zero. */
export function resolveStallDetection(overrides?: Partial<GateStallPolicy> | null): GateStallPolicy {
  return {
    repeatedLineThreshold: overrides?.repeatedLineThreshold ?? DEFAULT_GATE_STALL_POLICY.repeatedLineThreshold,
    silenceTimeoutSeconds: overrides?.silenceTimeoutSeconds ?? DEFAULT_GATE_STALL_POLICY.silenceTimeoutSeconds,
  };
}

/** Line assembly and repetition counting for both streams; no timers here. */
function createLineTracker(options: {
  readonly threshold: number;
  readonly onRepeat: (stream: StreamName, count: number) => void;
}): { observe(stream: StreamName, chunk: Uint8Array): void; end(stream: StreamName): void } {
  const streams: Record<StreamName, StreamState> = {
    stdout: newStreamState(),
    stderr: newStreamState(),
  };

  function acceptLine(stream: StreamName, line: string): void {
    const state = streams[stream];
    if (line.length + previousLength(state) > LINE_CAP) {
      // The line and the run's previous line would not fit the per-stream
      // bound together, so the line is overlong: it resets the run.
      resetRun(state);
      return;
    }
    handleLine(state, stream, line);
  }

  function handleLine(state: StreamState, stream: StreamName, line: string): void {
    if (line.trim() === "") {
      resetRun(state);
      return;
    }
    const repeats = state.lastLine === line;
    state.lastLine = line;
    state.count = repeats ? state.count + 1 : 1;
    if (options.threshold > 0 && state.count >= options.threshold) {
      options.onRepeat(stream, state.count);
    }
  }

  function appendPending(state: StreamState, text: string): void {
    if (state.discarding) return;
    state.pending += text;
    // A trailing CR may still prove to be the first half of a CRLF delimiter,
    // so it is not counted as line text yet.
    const counted = state.pending.endsWith("\r") ? state.pending.length - 1 : state.pending.length;
    if (counted + previousLength(state) <= LINE_CAP) return;
    // Overlong and still unterminated: drop it and skip through its delimiter.
    state.pending = "";
    state.discarding = true;
    resetRun(state);
  }

  function feedText(stream: StreamName, text: string): void {
    const state = streams[stream];
    let rest = text;
    while (rest.length > 0) {
      const newline = rest.indexOf("\n");
      if (newline < 0) {
        appendPending(state, rest);
        return;
      }
      const head = rest.slice(0, newline);
      rest = rest.slice(newline + 1);
      if (state.discarding) {
        state.discarding = false;
        continue;
      }
      const assembled = state.pending + head;
      state.pending = "";
      // A CR immediately before the LF is the LF half of one CRLF delimiter,
      // so it is not part of the line text and does not count toward the bound.
      acceptLine(stream, assembled.endsWith("\r") ? assembled.slice(0, -1) : assembled);
    }
  }

  function observe(stream: StreamName, chunk: Uint8Array): void {
    const text = streams[stream].decoder.decode(chunk, { stream: true });
    if (text.length > 0) feedText(stream, text);
  }

  function end(stream: StreamName): void {
    const state = streams[stream];
    const flushed = state.decoder.decode();
    if (flushed.length > 0) feedText(stream, flushed);
    if (state.discarding || state.pending.length === 0) return;
    // EOF of a live process: the unterminated tail is one final line. No LF
    // follows, so a trailing CR here is content, not a delimiter.
    const tail = state.pending;
    state.pending = "";
    acceptLine(stream, tail);
  }

  return { observe, end };
}

function newStreamState(): StreamState {
  return { decoder: new TextDecoder(), pending: "", discarding: false, lastLine: null, count: 0 };
}

/** Units the run's retained previous line occupies in this stream's budget. */
function previousLength(state: StreamState): number {
  return state.lastLine === null ? 0 : state.lastLine.length;
}

function resetRun(state: StreamState): void {
  state.lastLine = null;
  state.count = 0;
}
