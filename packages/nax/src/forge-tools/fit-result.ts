import { markdownFence } from "../utils/markdown-fence";
import type { ToolResultParts } from "./types";

function render(parts: ToolResultParts, entries: readonly string[], dropped: number): string {
  return [
    ...parts.header,
    markdownFence(
      [...(parts.fencedHeader ? [parts.fencedHeader.identity + parts.fencedHeader.detail] : []), ...entries].join("\n"),
    ),
    ...parts.footer,
    ...(dropped > 0 ? [`[truncated: ${dropped} entries not shown]`] : []),
  ].join("\n");
}

/** Largest fitting prefix size of a monotonic, rendered candidate sequence. */
function fittingSize(limit: number, fits: (size: number) => boolean): number {
  let low = 0;
  let high = limit;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  return low;
}

const METADATA_BUDGET_SHARE = 2;

/** Leave at least half the available payload budget for log entries, not check names. */
function budgetMetadata(parts: ToolResultParts, maxBytes: number): ToolResultParts {
  const metadata = parts.fencedHeader;
  if (!metadata) return parts;
  const bounded = { ...parts, fencedHeader: { ...metadata, detail: "" } };
  const dropped = parts.entries.length;
  const baseBytes = Buffer.byteLength(render(bounded, [], dropped), "utf8");
  const budget = baseBytes + Math.max(0, Math.floor((maxBytes - baseBytes) / METADATA_BUDGET_SHARE));
  const points = Array.from(metadata.detail);
  const size = fittingSize(points.length, (count) => {
    bounded.fencedHeader.detail = points.slice(0, count).join("");
    return Buffer.byteLength(render(bounded, [], dropped), "utf8") <= budget;
  });
  bounded.fencedHeader.detail = points.slice(0, size).join("");
  return bounded;
}

/**
 * Fit whole entries, measuring the final UTF-8 representation including its safe fence.
 * The caller's budget must accommodate trusted framing (headers, footers, empty
 * fence and truncation notice). If it cannot, framing wins: cutting it is unsafe.
 */
export function fitToolResult(input: ToolResultParts, maxBytes: number, keep: "start" | "end"): string {
  const full = render(input, input.entries, 0);
  if (Buffer.byteLength(full, "utf8") <= maxBytes) return full;
  const parts = budgetMetadata(input, maxBytes);
  const total = parts.entries.length;
  const select = (count: number) =>
    keep === "start" ? parts.entries.slice(0, count) : parts.entries.slice(total - count);
  const fits = (text: string) => Buffer.byteLength(text, "utf8") <= maxBytes;
  const bounded = render(parts, parts.entries, 0);
  if (fits(bounded)) return bounded;
  const count = fittingSize(total, (n) => fits(render(parts, select(n), total - n)));
  if (count > 0 || total === 0) return render(parts, select(count), total - count);
  return fitSingleEntry(parts, { maxBytes, keep });
}

function fitSingleEntry(parts: ToolResultParts, options: { maxBytes: number; keep: "start" | "end" }): string {
  const { keep, maxBytes } = options;
  const entry = parts.entries[keep === "start" ? 0 : parts.entries.length - 1];
  const prefix = parts.entryPrefix?.(entry) ?? "";
  const points = Array.from(entry.slice(prefix.length));
  const select = (n: number) =>
    prefix + (keep === "start" ? points.slice(0, n) : points.slice(points.length - n)).join("");
  const dropped = parts.entries.length - 1;
  const count = fittingSize(
    points.length,
    (n) => Buffer.byteLength(render(parts, [select(n)], dropped), "utf8") <= maxBytes,
  );
  return render(parts, [select(count)], dropped);
}
