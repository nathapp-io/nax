/**
 * The S1 move manifest: which files under packages/nax/src move into
 * packages/nax-agent, and where. One definition shared by the boundary
 * ratchet (check-agent-boundary.ts) and the S1-5 move script, so "what
 * moves" cannot drift between them (spec section 6).
 *
 * Entries are either a directory (`from` and `to` end with "/") or a single
 * .ts file. Paths are relative to packages/nax (`from`) and to
 * packages/nax-agent/src (`to`). A file joins the manifest in the PR that
 * makes it movable, e.g. the half of a split file.
 */
import { readFileSync } from "node:fs";

export interface MoveEntry {
  readonly from: string;
  readonly to: string;
}

export interface MoveManifest {
  readonly entries: readonly MoveEntry[];
}

function fail(message: string): never {
  throw new Error(`s1-move-manifest: ${message}`);
}

function parseEntry(raw: unknown, index: number): MoveEntry {
  if (typeof raw !== "object" || raw === null) fail(`entry ${index} is not an object`);
  const { from, to } = raw as Record<string, unknown>;
  if (typeof from !== "string" || typeof to !== "string") fail(`entry ${index} needs string "from" and "to"`);
  if (!from.startsWith("src/")) fail(`entry ${index} "${from}" must start with src/`);
  const isDir = from.endsWith("/");
  if (isDir && !to.endsWith("/")) fail(`entry ${index} "${from}" is a directory, so "to" must be a directory`);
  if (!isDir && !from.endsWith(".ts")) fail(`entry ${index} "${from}" must be a directory or a .ts file`);
  if (!isDir && !to.endsWith(".ts")) fail(`entry ${index} "${to}" must be a .ts file`);
  return { from, to };
}

export function parseMoveManifest(raw: unknown): MoveManifest {
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { entries?: unknown }).entries)) {
    fail('expected { "entries": [...] }');
  }
  const entries = (raw as { entries: unknown[] }).entries.map(parseEntry);
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.from)) fail(`duplicate source "${e.from}"`);
    seen.add(e.from);
  }
  const dirs = entries.filter((e) => e.from.endsWith("/"));
  for (const e of entries) {
    if (e.from.endsWith("/")) continue;
    const parent = dirs.find((d) => e.from.startsWith(d.from));
    if (parent) fail(`"${e.from}" is already covered by directory entry "${parent.from}"`);
  }
  return { entries };
}

export function loadMoveManifest(path: string): MoveManifest {
  return parseMoveManifest(JSON.parse(readFileSync(path, "utf8")));
}

function entryFor(manifest: MoveManifest, rel: string): MoveEntry | undefined {
  return manifest.entries.find((e) => (e.from.endsWith("/") ? rel.startsWith(e.from) : rel === e.from));
}

export function isInMoveSet(manifest: MoveManifest, rel: string): boolean {
  return entryFor(manifest, rel) !== undefined;
}

export function destinationOf(manifest: MoveManifest, rel: string): string | undefined {
  const e = entryFor(manifest, rel);
  if (e === undefined) return undefined;
  return e.from.endsWith("/") ? e.to + rel.slice(e.from.length) : e.to;
}
