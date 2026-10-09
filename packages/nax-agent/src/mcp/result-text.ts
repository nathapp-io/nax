/**
 * A `tools/call` result as text (S5-5 spec §5.4). Text items are kept; embedded
 * text resources keep their uri; binary content becomes a one-line placeholder;
 * structuredContent is printed only when no text item exists. Capped at
 * maxBytes on a code point boundary.
 */
import type { McpCallResult } from "#src/mcp/types";
import { cutToByteCap } from "#src/tools/truncate";

type Item = Readonly<Record<string, unknown>>;

const isItem = (value: unknown): value is Item => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

function resourceText(resource: unknown): string {
  if (!isItem(resource)) return "[resource omitted]";
  const text = str(resource.text);
  if (text !== undefined) return `${str(resource.uri) ?? ""}\n${text}`;
  return `[resource omitted: ${str(resource.mimeType) ?? "binary"}]`;
}

function itemText(item: Item): string {
  switch (item.type) {
    case "text":
      return str(item.text) ?? "";
    case "resource":
      return resourceText(item.resource);
    case "image":
    case "audio":
      return `[${item.type} omitted: ${str(item.mimeType) ?? "unknown"}]`;
    case "resource_link":
      return `[resource link: ${str(item.uri) ?? ""}]`;
    default:
      return `[${String(item.type ?? "unknown")} content omitted]`;
  }
}

export function resultText(raw: unknown, maxBytes: number): McpCallResult {
  const body = isItem(raw) ? raw : {};
  const items = Array.isArray(body.content) ? body.content.filter(isItem) : [];
  const hasText = items.some((item) => item.type === "text");
  const parts = items.map(itemText);
  if (!hasText && body.structuredContent !== undefined) parts.push(JSON.stringify(body.structuredContent));
  const full = parts.join("\n\n");
  const bytes = Buffer.byteLength(full, "utf8");
  const text = bytes <= maxBytes ? full : `${cutToByteCap(full, maxBytes)}\n[truncated: ${bytes} bytes in total]`;
  return { text, isError: body.isError === true, bytesBeforeCap: bytes };
}
