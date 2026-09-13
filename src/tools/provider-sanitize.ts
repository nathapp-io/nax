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

export function sanitizeProviderTools(kind: ProviderKind, tools: readonly ProviderTool[]): readonly ProviderTool[] {
  if (kind === "static") return tools;

  const out: ProviderTool[] = [];
  for (const tool of tools) {
    const schema = tool.inputSchema as unknown;
    if (typeof schema !== "object" || schema === null || Array.isArray(schema)) continue;
    if (JSON.stringify(schema).length > MAX_PROVIDER_SCHEMA_BYTES) continue;

    out.push({
      ...tool,
      localName: strip(tool.localName),
      description: strip(tool.description).slice(0, MAX_PROVIDER_DESCRIPTION_BYTES),
    });
  }
  return out;
}
