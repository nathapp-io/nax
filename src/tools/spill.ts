/**
 * Spill writer and the model-facing composition of the truncation policy
 * (US-003).
 *
 * The policy itself (`truncateForModel`) decides *what* the model may see; this
 * module decides what happens to the rest. On truncation only, the untruncated
 * body — up to `READ_CEILING` — is written under the scratchpad at
 * `spill/<toolName>-<callId>.txt`, and the marker naming that path and both byte
 * counts is appended to the content the model receives. `ScratchpadRead`
 * resolves paths relative to the scratchpad, so the marker names a *relative*
 * path and the spilled body stays recoverable with `offset`/`limit`.
 *
 * The composition lives here, beside the writer, because the marker and the
 * spill are one decision: the path may only appear in the marker when the write
 * actually succeeded. Both transports reach it — the coding-tool runtime applies
 * it to every genuine tool result, and the native session applies it at the
 * `after_tool` chokepoint — so there is exactly one implementation of the
 * model-facing cap rather than one per tool.
 *
 * Filesystem calls are injectable (`_spillDeps`), following `_scratchpadWipeDeps`
 * in src/execution/lifecycle/scratchpad-wipe.ts, and writes go through
 * Bun-native APIs rather than the Node synchronous ones.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getSafeLogger } from "@/logger";
import { errorMessage } from "@/utils/errors";
import { SCRATCHPAD_DIR } from "./scratchpad";
import {
  capModelLine,
  cutToByteCap,
  MODEL_MAX_BYTES,
  MODEL_MAX_LINE_CHARS,
  MODEL_MAX_LINES,
  READ_CEILING,
  splitModelLines,
  type TruncationDirection,
  truncateForModel,
  truncationDirectionFor,
} from "./truncate";

/** Directory under the scratchpad that holds spilled tool output. */
export const SPILL_DIR = "spill";

/** Injectable filesystem seam (see docs/architecture/conventions.md §2). */
export const _spillDeps = {
  mkdir: (path: string): Promise<string | undefined> => mkdir(path, { recursive: true }),
  writeFile: (path: string, data: string): Promise<number> => Bun.write(path, data),
};

export interface SpillRequest {
  /** Absolute root holding `.nax/scratchpad/` — the same root the tools are confined to. */
  readonly root: string;
  readonly toolName: string;
  readonly callId: string;
  /** The untruncated body, exactly as the tool returned it. */
  readonly body: string;
}

/** A tool name or call id can only contribute path-safe characters. */
function fileSafe(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** `spill/<toolName>-<callId>.txt`, relative to the scratchpad directory. */
export function spillRelativePath(toolName: string, callId: string): string {
  return `${SPILL_DIR}/${fileSafe(toolName)}-${fileSafe(callId)}.txt`;
}

/**
 * The spill file's body: the untruncated output, bounded by `READ_CEILING`.
 *
 * A body past the ceiling is itself cut, and the cut is recorded on the file's
 * own last line: a spill that silently ends mid-output is indistinguishable
 * from one that ends where the tool did, and the model is being told it holds
 * the whole thing. The note is paid for out of the ceiling, never added on top
 * of it — the file is the tool-layer bound, so it must not exceed it either.
 */
function spillBody(body: string): string {
  const total = Buffer.byteLength(body, "utf8");
  if (total <= READ_CEILING) return body;
  // Two passes because the note quotes how much was kept, which depends on the
  // note's own length. The first pass sizes the note with the largest number it
  // could report (the ceiling), so the second can only make it shorter.
  const noteOf = (kept: number): string => `\n... [spill incomplete: showing ${kept} of ${total} bytes]`;
  const firstNote = noteOf(READ_CEILING);
  const kept = cutToByteCap(body, READ_CEILING - Buffer.byteLength(firstNote, "utf8"));
  return `${kept}${noteOf(Buffer.byteLength(kept, "utf8"))}`;
}

/**
 * Write the untruncated body under the scratchpad and return its path relative
 * to the scratchpad, or `undefined` when the write failed.
 *
 * Failure is fail-open by contract: the caller still delivers the truncated
 * result. What it must not do is name a file that is not there, which is why
 * this returns the path rather than a boolean.
 */
export async function writeSpill(req: SpillRequest): Promise<string | undefined> {
  const relative = spillRelativePath(req.toolName, req.callId);
  const target = join(req.root, SCRATCHPAD_DIR, relative);
  try {
    await _spillDeps.mkdir(dirname(target));
    await _spillDeps.writeFile(target, spillBody(req.body));
    return relative;
  } catch (err) {
    getSafeLogger()?.warn("tools", "[spill] could not write the spilled tool result", {
      tool: req.toolName,
      path: target,
      error: errorMessage(err),
    });
    return undefined;
  }
}

export interface ModelTruncationOptions {
  readonly toolName: string;
  /** Identifies the spill file; the model's own tool-call id when it has one. */
  readonly callId: string;
  /** Absolute root to spill under. Omitted means no spill, and no path in the marker. */
  readonly root?: string;
  /** Model-facing byte ceiling. Defaults to `MODEL_MAX_BYTES`. */
  readonly maxBytes?: number;
}

/** Render a marker. The delivered count is interpolated at call time, so the
 * caller can first size the marker against the widest number it could report
 * (the original byte count) and never overshoot the byte ceiling.
 */
type MarkerRenderer = (deliveredBytes: number) => string;

/**
 * The marker shapes, widest first. A narrower shape is used when the wider one
 * cannot fit the byte budget — a 40 000-byte ceiling fits a marker naming the
 * spill path, a 32-byte one fits barely more than the word "truncated". The
 * spill path is simply absent from a shape that has no room for it, which is
 * also the shape failure takes: a marker never names a file that is not there.
 */
function markerShapes(originalBytes: number, spillPath: string | undefined): MarkerRenderer[] {
  const shapes: MarkerRenderer[] = [];
  if (spillPath !== undefined) {
    shapes.push((d) => `... [truncated: full output at ${spillPath}; showing ${d} of ${originalBytes} bytes]`);
  }
  shapes.push((d) => `... [truncated: showing ${d} of ${originalBytes} bytes]`);
  shapes.push(() => "... [truncated]");
  return shapes;
}

/** Lines `head` may keep once the marker occupies one of them. */
function trimToLineBudget(head: string, maxLines: number): string {
  const lines = splitModelLines(head);
  if (lines.length <= maxLines) return head;
  return lines.slice(0, maxLines).join("\n");
}

/** A marker line, plus the newline that puts it on one. */
function renderedMarkerBytes(render: MarkerRenderer, deliveredBytes: number): number {
  return Buffer.byteLength(render(deliveredBytes), "utf8") + 1;
}

/**
 * Compose the head-direction result: the policy's content, then the marker on
 * its own last line. The marker is inside the byte and line budgets, never
 * appended past them.
 */
function composeHead(content: string, originalBytes: number, byteCap: number, spillPath: string | undefined): string {
  for (const render of markerShapes(originalBytes, spillPath)) {
    const bodyBudget = byteCap - renderedMarkerBytes(render, originalBytes);
    if (bodyBudget < 0) continue;
    const head = trimToLineBudget(cutToByteCap(content, bodyBudget), MODEL_MAX_LINES - 1);
    return `${head}\n${render(Buffer.byteLength(head, "utf8"))}`;
  }
  return cutToByteCap(content, byteCap);
}

/**
 * Compose the tail-with-first-line result: the body's first line, the marker,
 * then the tail.
 *
 * The marker sits between them rather than after the tail because the tail is
 * the whole point of the direction — a marker appended last would push the
 * final stderr lines out of view, which is the failure the direction exists to
 * prevent. Command output is kept line-wise, and a line too large for the
 * remaining budget is skipped rather than cut: one 160 KB stdout blob must not
 * spend the entire budget on itself and evict the short lines that follow it.
 */
function composeTail(
  body: string,
  content: string,
  originalBytes: number,
  byteCap: number,
  spillPath: string | undefined,
): string {
  const lines = splitModelLines(body);
  const fullFirstLine = content.split("\n")[0] ?? "";
  for (const render of markerShapes(originalBytes, spillPath)) {
    // One byte for the newline after the first line, then the marker.
    const forFirstLine = byteCap - Buffer.byteLength(render(originalBytes), "utf8") - 1;
    if (forFirstLine < 0) continue;
    const firstLine =
      Buffer.byteLength(fullFirstLine, "utf8") > forFirstLine
        ? cutToByteCap(fullFirstLine, forFirstLine)
        : fullFirstLine;
    // One more byte for the newline that opens the tail.
    const tailBudget = forFirstLine - Buffer.byteLength(firstLine, "utf8") - 1;
    const tail = tailBudget < 0 ? "" : selectTail(lines, tailBudget);
    const firstLineBytes = Buffer.byteLength(firstLine, "utf8");
    const tailBytes = Buffer.byteLength(tail, "utf8");
    // The delivered count is the body text the model can read back: the retained
    // first line, the body's own newline that still separates it from the tail,
    // and the tail. The newline that puts the marker on a line of its own is not
    // a body byte — here it is the one that opens the tail, and with no tail
    // retained there is no body byte after the first line at all. `composeHead`
    // reports its head with no marker-line byte either; counting one only here
    // made the same marker mean a different width per tool, and reported one
    // byte more than the model can actually read.
    const delivered = tail === "" ? firstLineBytes : firstLineBytes + 1 + tailBytes;
    const marker = render(delivered);
    return tail === "" ? `${firstLine}\n${marker}` : `${firstLine}\n${marker}\n${tail}`;
  }
  return cutToByteCap(content, byteCap);
}

/**
 * The trailing lines that fit `budget` bytes, taken from the end of the body.
 *
 * A line whose own length exceeds what is left is skipped, not truncated: the
 * alternative spends the whole budget inside that one line and returns a slice
 * of it in place of the lines that carry the signal (an echoed command, the
 * error text). Each line kept is still shaped by the per-line cap.
 */
function selectTail(lines: readonly string[], budget: number): string {
  const kept: string[] = [];
  let remaining = budget;
  // The first line is retained separately, so the walk starts below it, and the
  // first line plus the marker occupy one line each of the line budget.
  for (let i = lines.length - 1; i >= 1 && kept.length < MODEL_MAX_LINES - 1; i -= 1) {
    const line = lines[i] ?? "";
    const cost = Buffer.byteLength(line, "utf8") + (kept.length === 0 ? 0 : 1);
    if (cost > remaining) continue;
    kept.unshift(capModelLine(line, MODEL_MAX_LINE_CHARS));
    remaining -= cost;
  }
  return kept.join("\n");
}

/**
 * Apply the model-facing truncation policy to one tool result.
 *
 * Returns the body unchanged when it is within every cap — no spill, no marker.
 * Otherwise the shared policy shapes the content, the untruncated body is
 * spilled when a root is known, and the marker naming both byte counts and the
 * spill path is composed inside the same ceilings the body obeys.
 *
 * The byte ceiling is the caller's `maxBytes`, defaulting to `MODEL_MAX_BYTES`;
 * the line ceilings always come from the shared policy's constants.
 */
export async function applyModelTruncationPolicy(body: string, opts: ModelTruncationOptions): Promise<string> {
  const direction: TruncationDirection = truncationDirectionFor(opts.toolName);
  const originalBytes = Buffer.byteLength(body, "utf8");
  const byteCap = Math.max(0, opts.maxBytes ?? MODEL_MAX_BYTES);

  // The one call to the shared policy: it applies the per-line cap, the
  // line-count cap and its own byte cap, and tells us whether anything was cut.
  const shaped = truncateForModel(body, { direction });
  if (!shaped.truncated && originalBytes <= byteCap) return body;

  const spillPath =
    opts.root === undefined
      ? undefined
      : await writeSpill({ root: opts.root, toolName: opts.toolName, callId: opts.callId, body });

  return direction === "head"
    ? composeHead(shaped.content, originalBytes, byteCap, spillPath)
    : composeTail(body, shaped.content, originalBytes, byteCap, spillPath);
}
