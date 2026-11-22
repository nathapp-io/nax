/**
 * A bounded, line-aware tail of one shell's output: the last lines a foreground Bash card or a
 * shell view draws while the command runs.
 *
 * One tail serves stdout and stderr in arrival order: a single streaming UTF-8 decoder (malformed
 * bytes become U+FFFD) and a single partial line. `\n` ends a line and a `\r\n` ends one line even
 * when its two bytes arrive in different chunks; a `\r` followed by anything else clears the
 * partial line, so a progress line that redraws itself replaces its own text. Blank lines are kept.
 * The last line without a newline is the partial line, and counts toward both caps.
 *
 * Two caps bound what is retained, oldest lines dropped first: how many lines (the partial line
 * included) and how many UTF-8 bytes of line text, newlines not counted. A single line longer than
 * the byte cap keeps only its newest bytes, cut on a character boundary. Any drop sets `truncated`,
 * so a consumer can say that the log file holds what the tail does not.
 */
import type { ShellTailView } from "./task-types";

/** The most lines one tail retains, the partial line included. */
export const SHELL_TAIL_MAX_LINES = 2000;
/** The most UTF-8 bytes of line text one tail retains; newlines are not counted. */
export const SHELL_TAIL_MAX_BYTES = 256 * 1024;
/** The most often a consumer redraws for tail changes; the registry notifies per append. */
export const SHELL_TAIL_REFRESH_MS = 100;

/** The caps a tail keeps to; each may be lowered, which is what tests do. */
export interface ShellTailLimits {
  readonly maxLines: number;
  readonly maxBytes: number;
}

export interface ShellTail {
  /** Decode and append one chunk of the shell's output; a chunk may split a character or a line. */
  append(chunk: Uint8Array): void;
  /** The retained lines and whether anything was dropped; stable until the next change. */
  view(): ShellTailView;
  /** The UTF-8 bytes of the retained line text, the partial line included. */
  bytes(): number;
  /** Forget everything and report the tail as truncated. */
  evict(): void;
}

/** One retained complete line, with the UTF-8 byte count the caps are kept in step by. */
interface TailLine {
  readonly text: string;
  readonly bytes: number;
}

const encoder = new TextEncoder();

/** The UTF-8 bytes `text` occupies. */
function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** The bytes one code point occupies in UTF-8. */
function codePointBytes(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/** Walk `text` from its end, yielding each code point's UTF-16 width and UTF-8 byte size. */
function tailCodePoint(text: string, index: number): { readonly width: number; readonly bytes: number } {
  const low = text.charCodeAt(index - 1);
  const high = index >= 2 ? text.charCodeAt(index - 2) : Number.NaN;
  const paired = low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff;
  if (paired) return { width: 2, bytes: 4 };
  return { width: 1, bytes: codePointBytes(low) };
}

/** The newest suffix of `text` that fits in `maxBytes`, cut on a code point boundary. */
function newestBytes(text: string, maxBytes: number): string {
  let bytes = 0;
  let index = text.length;
  while (index > 0) {
    const codePoint = tailCodePoint(text, index);
    if (bytes + codePoint.bytes > maxBytes) break;
    bytes += codePoint.bytes;
    index -= codePoint.width;
  }
  return text.slice(index);
}

export function createShellTail(limits?: ShellTailLimits): ShellTail {
  const maxLines = limits?.maxLines ?? SHELL_TAIL_MAX_LINES;
  const maxBytes = limits?.maxBytes ?? SHELL_TAIL_MAX_BYTES;

  let decoder = new TextDecoder("utf-8");
  let lines: TailLine[] = [];
  let linesBytes = 0;
  let partial = "";
  let partialBytes = 0;
  let hasPartial = false;
  let pendingCr = false;
  let truncated = false;
  let cached: ShellTailView | undefined;

  function changed(): void {
    cached = undefined;
  }

  function keptLines(): number {
    return lines.length + (hasPartial ? 1 : 0);
  }

  function totalBytes(): number {
    return linesBytes + partialBytes;
  }

  /** Drop the oldest complete lines until the tail fits both caps; the partial line is newest. */
  function trim(): void {
    while (lines.length > 0 && (keptLines() > maxLines || totalBytes() > maxBytes)) {
      const oldest = lines.shift();
      if (oldest === undefined) break;
      linesBytes -= oldest.bytes;
      truncated = true;
    }
  }

  function clearPartial(): void {
    partial = "";
    partialBytes = 0;
    hasPartial = false;
  }

  /** Keep only the newest bytes of a line that outgrew the byte cap on its own. */
  function capped(text: string, bytes: number): TailLine {
    if (bytes <= maxBytes) return { text, bytes };
    truncated = true;
    const kept = newestBytes(text, maxBytes);
    return { text: kept, bytes: byteLength(kept) };
  }

  function endLine(): void {
    const line = capped(partial, partialBytes);
    lines.push(line);
    linesBytes += line.bytes;
    clearPartial();
    pendingCr = false;
    trim();
    changed();
  }

  function appendText(text: string): void {
    if (text === "") return;
    partial += text;
    partialBytes += byteLength(text);
    hasPartial = true;
    if (partialBytes > maxBytes) {
      const kept = capped(partial, partialBytes);
      partial = kept.text;
      partialBytes = kept.bytes;
    }
    trim();
    changed();
  }

  return {
    append(chunk) {
      if (chunk.length === 0) return;
      const text = decoder.decode(chunk, { stream: true });
      let index = 0;
      while (index < text.length) {
        const char = text[index];
        if (char === "\r") {
          pendingCr = true;
          index += 1;
          continue;
        }
        if (char === "\n") {
          endLine();
          index += 1;
          continue;
        }
        if (pendingCr) {
          clearPartial();
          pendingCr = false;
        }
        let end = index + 1;
        while (end < text.length && text[end] !== "\r" && text[end] !== "\n") end += 1;
        appendText(text.slice(index, end));
        index = end;
      }
    },
    view() {
      if (cached !== undefined) return cached;
      const kept = lines.map((line) => line.text);
      if (hasPartial) kept.push(partial);
      cached = { lines: kept, truncated };
      return cached;
    },
    bytes: totalBytes,
    evict() {
      lines = [];
      linesBytes = 0;
      clearPartial();
      pendingCr = false;
      decoder = new TextDecoder("utf-8");
      truncated = true;
      changed();
    },
  };
}
