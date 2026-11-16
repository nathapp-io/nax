import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export const ENABLE_MOUSE = "\u001b[?1003h\u001b[?1006h";
export const DISABLE_MOUSE = "\u001b[?1006l\u001b[?1003l";

/**
 * How long a trailing `ESC` (or `ESC-[`) is held before it is forwarded alone. A read can end
 * between the bytes of a mouse report's own prefix, and forwarding the ESC on its own hands Ink
 * a lone Escape — `key.escape` — mid-report. A real Esc press is still delivered, 50 ms later.
 */
export const ESC_FLUSH_MS = 50;

/** An armed timer's opaque handle: the runtime's here, the fake clock's in a test. */
type TimerHandle = ReturnType<typeof setTimeout> | number;

/**
 * Injected seams: the flush timer, which a test drives from a fake clock instead of waiting.
 * `setTimeout` is used rather than `Bun.sleep` because the timer must be cancelled when the next
 * read continues the held prefix, or the adapter is disposed.
 */
export const _mouseInputDeps: {
  setTimeout: (callback: () => void, ms: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
} = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

export type MouseButton = "left" | "middle" | "right" | "none";
export interface MouseEvent {
  readonly kind: "press" | "release" | "drag" | "move" | "wheelUp" | "wheelDown";
  readonly button: MouseButton;
  /** 1-based terminal column and row, as the terminal reports them. */
  readonly x: number;
  readonly y: number;
}
export interface MouseEvents {
  subscribe(listener: (event: MouseEvent) => void): () => void;
}
export interface MouseInput {
  /** What Ink reads: the source with every complete SGR mouse report removed. */
  readonly stdin: NodeJS.ReadStream;
  readonly events: MouseEvents;
  dispose(): void;
}

const REPORT_PREFIX = "\u001b[<";
// The two byte-prefixes of a report that a read can end inside, before `REPORT_PREFIX` is complete.
const BARE_ESC = "\u001b";
const ESC_BRACKET = `${BARE_ESC}[`;
// Far beyond ordinary terminal reports; bounds retained stdin data even without a terminator.
const MAX_PENDING_REPORT_LENGTH = 64;
// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR reports begin with the terminal ESC control byte.
const REPORT = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Only an ESC-[< prefix starts a buffered mouse report.
const PARTIAL_REPORT = /^\u001b\[<(?:\d*|\d+;\d*|\d+;\d+;\d*)$/;
const BUTTON_MASK = 3;
const MOTION_BIT = 32;
const WHEEL_BIT = 64;
const BUTTONS: readonly MouseButton[] = ["left", "middle", "right", "none"];

export function parseSgrMouse(sequence: string): MouseEvent | undefined {
  const match = REPORT.exec(sequence);
  if (!match || match[0] !== sequence) return undefined;
  const bits = Number(match[1]);
  const buttonIndex = bits & BUTTON_MASK;
  const x = Number(match[2]);
  const y = Number(match[3]);
  if (bits & WHEEL_BIT) {
    if (buttonIndex > 1) return undefined;
    return { kind: buttonIndex === 0 ? "wheelUp" : "wheelDown", button: "none", x, y };
  }
  const button = BUTTONS[buttonIndex] ?? "none";
  const kind = match[4] === "m" ? "release" : bits & MOTION_BIT ? (button === "none" ? "move" : "drag") : "press";
  return { kind, button, x, y };
}

/** Split only full SGR prefixes; a report prefix that is still incomplete comes back as `pending`. */
function filterReports(text: string, emit: (event: MouseEvent) => void): { keys: string; pending: string } {
  let keys = "";
  let cursor = 0;
  let start = text.indexOf(REPORT_PREFIX);
  while (start !== -1) {
    keys += text.slice(cursor, start);
    const tail = text.slice(start);
    const match = REPORT.exec(tail);
    if (match) {
      const event = parseSgrMouse(match[0]);
      if (event) emit(event);
      cursor = start + match[0].length;
    } else {
      // `$` also matches before a final newline; require the entire tail to match.
      if (tail.length <= MAX_PENDING_REPORT_LENGTH && PARTIAL_REPORT.exec(tail)?.[0] === tail) {
        return { keys, pending: tail };
      }
      keys += REPORT_PREFIX;
      cursor = start + REPORT_PREFIX.length;
    }
    start = text.indexOf(REPORT_PREFIX, cursor);
  }
  return { keys: keys + text.slice(cursor), pending: "" };
}

type MouseSource = Pick<NodeJS.ReadStream, "isTTY" | "isRaw"> & {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  setRawMode(mode: boolean): unknown;
  ref(): unknown;
  unref(): unknown;
};

function inkStream(source: MouseSource) {
  const stream = Object.assign(new PassThrough(), {
    get isTTY() {
      return source.isTTY;
    },
    setRawMode(mode: boolean) {
      source.setRawMode(mode);
      return stream;
    },
    ref() {
      source.ref();
      return stream;
    },
    unref() {
      source.unref();
      return stream;
    },
    get isRaw() {
      return source.isRaw;
    },
  });
  // PassThrough's native setEncoding must remain intact: Ink reads strings from this stream.
  return stream;
}

/** A chunk can end between the bytes of a report's own prefix: `ESC` alone, or `ESC-[`. */
function escPrefixSuffix(keys: string): string {
  if (keys.endsWith(ESC_BRACKET)) return ESC_BRACKET;
  if (keys.endsWith(BARE_ESC)) return BARE_ESC;
  return "";
}

export function createMouseInput(source: MouseSource): MouseInput {
  const stdin = inkStream(source);
  const decoder = new StringDecoder("utf8");
  const listeners = new Set<(event: MouseEvent) => void>();
  /** An incomplete SGR report: held until the next read completes or breaks it. */
  let pending = "";
  /** A trailing `ESC` / `ESC-[`: held until `ESC_FLUSH_MS` passes, so it is never a lone Esc. */
  let held = "";
  let flushHandle: TimerHandle | undefined;
  const emit = (event: MouseEvent): void => {
    for (const listener of listeners) listener(event);
  };
  const clearFlush = (): void => {
    if (flushHandle === undefined) return;
    _mouseInputDeps.clearTimeout(flushHandle);
    flushHandle = undefined;
  };
  /** The prefix was never completed: it was a real Esc press, so it now reaches Ink alone. */
  const flushHeld = (): void => {
    flushHandle = undefined;
    const text = held;
    held = "";
    if (text) stdin.write(text);
  };
  const onData = (chunk: Buffer | string): void => {
    clearFlush();
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    const result = filterReports(held + pending + text, emit);
    const hold = escPrefixSuffix(result.keys);
    pending = result.pending;
    held = hold;
    const forward = hold ? result.keys.slice(0, result.keys.length - hold.length) : result.keys;
    if (forward) stdin.write(forward);
    if (hold) flushHandle = _mouseInputDeps.setTimeout(flushHeld, ESC_FLUSH_MS);
  };
  source.on("data", onData);
  return {
    // Ink uses only the readable stream and the TTY controls above, not tty.ReadStream's socket APIs.
    stdin: stdin as unknown as NodeJS.ReadStream,
    events: {
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    dispose() {
      source.off("data", onData);
      listeners.clear();
      clearFlush();
      pending = "";
      held = "";
    },
  };
}
