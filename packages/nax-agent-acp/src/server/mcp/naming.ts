/**
 * Model-facing MCP tool names (S5-5 spec §5.1): `<server>__<tool>`, each part
 * reduced to [A-Za-z0-9_-], a server part starting with a non-letter prefixed
 * `m`. Over 64 characters, or colliding with another tool's name, a name is cut
 * to 55 and given `_` + 8 hex chars of SHA-256 over `server\0tool`. Built-in
 * tool names contain no `__`, so they never collide.
 */
import { createHash } from "node:crypto";

export const TOOL_NAME_MAX = 64;
const CUT = 55;

export interface ToolRef {
  readonly server: string;
  readonly tool: string;
}

export interface NamedTool extends ToolRef {
  readonly modelName: string;
}

const clean = (part: string): string => part.replace(/[^A-Za-z0-9_-]/g, "_");

function baseName(ref: ToolRef): string {
  const server = clean(ref.server);
  return `${/^[A-Za-z]/.test(server) ? server : `m${server}`}__${clean(ref.tool)}`;
}

function hashed(ref: ToolRef, base: string): string {
  const digest = createHash("sha256").update(`${ref.server}\0${ref.tool}`).digest("hex").slice(0, 8);
  return `${base.slice(0, CUT)}_${digest}`;
}

export function nameTools(refs: readonly ToolRef[]): {
  readonly named: readonly NamedTool[];
  readonly dropped: readonly ToolRef[];
} {
  const bases = refs.map(baseName);
  const counts = new Map<string, number>();
  for (const base of bases) counts.set(base, (counts.get(base) ?? 0) + 1);
  const named: NamedTool[] = [];
  const dropped: ToolRef[] = [];
  const used = new Set<string>();
  refs.forEach((ref, i) => {
    const base = bases[i] ?? "";
    const modelName = base.length > TOOL_NAME_MAX || (counts.get(base) ?? 0) > 1 ? hashed(ref, base) : base;
    if (used.has(modelName)) {
      dropped.push(ref);
      return;
    }
    used.add(modelName);
    named.push({ ...ref, modelName });
  });
  return { named, dropped };
}
