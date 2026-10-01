/**
 * Bounds on what a `discovered` provider may put into the model's tool list.
 *
 * A discovered tool's description and schema come from an external process and
 * go straight into the prompt, which makes the description a prompt-injection
 * surface and the schema a per-hop context tax paid whether or not the tool is
 * ever called. A `static` provider's schema is authored in this repo, so
 * sanitising it would be theatre — hence the kind check rather than a blanket
 * pass.
 *
 * Truncate rather than drop: an over-long description degrades into a shorter
 * one, where dropping would remove a working tool over a cosmetic problem. A
 * malformed or oversized SCHEMA is different — it cannot be safely truncated,
 * so that one tool is skipped and its siblings survive.
 */
import type { ProviderKind, ProviderTool } from "./provider-types";

export const MAX_PROVIDER_DESCRIPTION_BYTES = 2_000;
export const MAX_PROVIDER_SCHEMA_BYTES = 20_000;

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control bytes is the point of this function
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

function strip(value: string): string {
  return value.replace(CONTROL_CHARS, "");
}

/**
 * Truncate to a byte ceiling without splitting a code point.
 *
 * `String.prototype.slice` counts UTF-16 code units, so a multi-byte code point
 * straddling the boundary is cut in half and becomes a replacement character.
 * Iterating code points and stopping at the ceiling keeps the result valid.
 */
function truncateToBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let out = "";
  let bytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    out += char;
    bytes += charBytes;
  }
  return out;
}

export function sanitizeProviderTools(kind: ProviderKind, tools: readonly ProviderTool[]): readonly ProviderTool[] {
  if (kind === "static") return tools;

  const out: ProviderTool[] = [];
  let schemaBytes = 0;
  for (const tool of tools) {
    const schema = tool.inputSchema as unknown;
    if (typeof schema !== "object" || schema === null || Array.isArray(schema)) continue;
    // US-005 caps the TOTAL schema bytes one provider may put into the prompt,
    // not just each schema: many small tools still add up to an unbounded hop
    // tax. A single oversized schema fails the same test with a zero running
    // total, which preserves the per-tool skip this file already had.
    const toolBytes = Buffer.byteLength(JSON.stringify(schema), "utf8");
    if (schemaBytes + toolBytes > MAX_PROVIDER_SCHEMA_BYTES) continue;
    schemaBytes += toolBytes;

    out.push({
      ...tool,
      localName: strip(tool.localName),
      description: truncateToBytes(strip(tool.description), MAX_PROVIDER_DESCRIPTION_BYTES),
    });
  }
  return out;
}
