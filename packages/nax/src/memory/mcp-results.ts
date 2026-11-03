/**
 * mcp-results.ts — pure adapters from MCP tool-result text to memory items.
 *
 * An MCP tool result reaches nax as text (`McpCallResult.content`). Memory
 * servers (OpenMemory, mem0-compatible) answer with JSON: an array of items, or
 * an object whose `results` is that array. Anything else — prose, an error
 * string, another shape — reads as "no items" rather than as a failure, because
 * the shapes handled here are the documented ones and nothing more.
 *
 * Internal to `src/memory/`: not exported from the barrel.
 */

import type { MemoryHit, MemoryScope } from "@nathapp/nax-agent";

/** One memory a server returned: its remote id (if any), its text and its relevance score (if any). */
export interface McpMemoryItem {
  readonly id?: string;
  readonly text: string;
  readonly score?: number;
}

/** A hit's one-line description is cut to this many characters. */
export const MCP_HIT_DESCRIPTION_MAX_CHARS = 160;
/** A hit's snippet (the whole memory, bounded) is cut to this many characters. */
export const MCP_HIT_SNIPPET_MAX_CHARS = 1000;
/** Characters of the sanitised remote id kept in a hit slug, after the `mcp-` prefix. */
const MCP_HIT_SLUG_ID_MAX_CHARS = 60;
const MCP_HIT_SLUG_PREFIX = "mcp-";
/** Item fields searched for the memory text, in order of preference. */
const TEXT_FIELDS = ["memory", "text", "content"] as const;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The raw item list of a result text, or `[]` when it is not JSON or not a documented shape. */
function rawItems(text: string): readonly unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON (a prose answer such as "ok"): an unparseable result carries no items.
    return [];
  }
  if (Array.isArray(parsed)) return parsed;
  if (isRecord(parsed) && Array.isArray(parsed.results)) return parsed.results;
  return [];
}

function textOf(item: JsonRecord): string | undefined {
  for (const field of TEXT_FIELDS) {
    const value = item[field];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/**
 * Parse a search result into memory items.
 *
 * An item with no string `memory` / `text` / `content` field is dropped.
 *
 * @param text - The `McpCallResult.content` of a search call
 */
export function parseMcpMemoryItems(text: string): readonly McpMemoryItem[] {
  const items: McpMemoryItem[] = [];
  for (const raw of rawItems(text)) {
    if (!isRecord(raw)) continue;
    const itemText = textOf(raw);
    if (itemText === undefined) continue;
    items.push({
      ...(typeof raw.id === "string" ? { id: raw.id } : {}),
      text: itemText,
      ...(typeof raw.score === "number" && Number.isFinite(raw.score) ? { score: raw.score } : {}),
    });
  }
  return items;
}

/**
 * Parse an add result into the remote ids it carries.
 *
 * Unlike {@link parseMcpMemoryItems} an item contributes its id with or without
 * a text field: an add answer such as `[{"id":"r1","event":"ADD"}]` has no
 * memory text.
 *
 * @param text - The `McpCallResult.content` of an add call
 */
export function parseMcpMemoryIds(text: string): readonly string[] {
  const ids: string[] = [];
  for (const raw of rawItems(text)) {
    if (isRecord(raw) && typeof raw.id === "string") ids.push(raw.id);
  }
  return ids;
}

function slugOf(item: McpMemoryItem, index: number): string {
  if (item.id === undefined || item.id === "") return `${MCP_HIT_SLUG_PREFIX}${index + 1}`;
  const folded = item.id.toLowerCase().replace(/[^a-z0-9]/g, "-");
  return `${MCP_HIT_SLUG_PREFIX}${folded.slice(0, MCP_HIT_SLUG_ID_MAX_CHARS)}`;
}

/**
 * Map one remote item to a search hit.
 *
 * @param item - A parsed memory item
 * @param index - The item's position in the result (numbers an id-less item's slug)
 * @param scope - The scope the search was asked for
 */
export function mcpHitOf(item: McpMemoryItem, index: number, scope: MemoryScope): MemoryHit {
  const firstLine = item.text.split("\n", 1)[0] ?? "";
  return {
    slug: slugOf(item, index),
    scope,
    type: "reference",
    status: "active",
    description: firstLine.slice(0, MCP_HIT_DESCRIPTION_MAX_CHARS),
    snippet: item.text.slice(0, MCP_HIT_SNIPPET_MAX_CHARS),
    score: item.score ?? 0,
  };
}
