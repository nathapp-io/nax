/**
 * The `nax-memory` tool provider: the four memory tools a session is handed.
 *
 * The provider is a thin shell over the host (`host.ts`), which owns every read
 * and every write. What lives here is the shape the model sees — the schemas, the
 * input checks, the JSON each tool answers with — and the rule that a tool never
 * throws at the model: a bad input or a failing read comes back as `isError` with
 * a `[memory] ` line, so the session can correct itself instead of losing the turn.
 *
 * The input checks are shape checks only: a required string is present, a scope is
 * one of the two, `limit` is inside 1-50, and a slug matches `MEMORY_SLUG_RE`
 * before the host is ever asked. What a note may *contain* — its type, its lengths,
 * whether it carries a secret — is the store's business, not this provider's, so a
 * save is validated once, where the note is written.
 *
 * `get` takes a slug and never an id: ids are the provider's own, and the index a
 * session reads lists slugs. `save` and `forget` are present with their schemas and
 * their input checks, and answer `[memory] not implemented` until the write story
 * lands; nothing here reaches the host's write surface yet.
 */
import type { MemoryHit, MemoryNote, MemoryScope, ProviderTool, ToolProvider, ToolResult } from "@nathapp/nax-agent";
import { MEMORY_SLUG_RE } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { buildMemoryToolInstructions } from "@/prompts";
import type { MemoryHost, MemorySearchInput } from "./host";

/** The provider id every memory tool is namespaced under: `nax-memory__get`. */
export const MEMORY_TOOL_PROVIDER_ID = "nax-memory";

/** How many hits `search` keeps when the request names no limit. */
const SEARCH_LIMIT_DEFAULT = 10;
/** Smallest and largest `limit` a search may name, as the schema states them. */
const SEARCH_LIMIT_MIN = 1;
const SEARCH_LIMIT_MAX = 50;
/** The scope a request that names none is read in. */
const DEFAULT_SCOPE: MemoryScope = "project";
/** The two scopes, as the schema enumerates them and the checker accepts them. */
const SCOPE_VALUES: readonly MemoryScope[] = ["project", "user"];
/** The fields `save` cannot be called without; its schema requires the same four. */
const SAVE_REQUIRED_FIELDS = ["slug", "type", "description", "body"] as const;
/** What a write tool answers until the write story implements it. */
const NOT_IMPLEMENTED: ToolResult = { isError: true, content: "[memory] not implemented" };

/** A tool's input after its shape checks, or the refusal that stopped it. */
type Checked<T> = { readonly ok: true; readonly input: T } | { readonly ok: false; readonly result: ToolResult };

/** The one refusal every shape check is written with: the field, and what arrived. */
function refused(field: string, value: unknown): Checked<never> {
  return { ok: false, result: { isError: true, content: `[memory] invalid ${field} ${String(value)}` } };
}

/** The scope a request names, or `project` when it names none. */
function scopeOf(input: Record<string, unknown>): Checked<MemoryScope> {
  const value = input.scope;
  if (value === undefined) return { ok: true, input: DEFAULT_SCOPE };
  const scope = SCOPE_VALUES.find((candidate) => candidate === value);
  if (scope === undefined) return refused("scope", value);
  return { ok: true, input: scope };
}

/** A required slug: a non-empty string that is one. */
function slugOf(input: Record<string, unknown>): Checked<string> {
  const value = input.slug;
  if (typeof value !== "string" || !MEMORY_SLUG_RE.test(value)) return refused("slug", value);
  return { ok: true, input: value };
}

/** A required, non-empty string field. */
function stringOf(input: Record<string, unknown>, field: string): Checked<string> {
  const value = input[field];
  if (typeof value !== "string" || value === "") return refused(field, value);
  return { ok: true, input: value };
}

/** The search limit, defaulting to 10 and refused outside 1-50. */
function limitOf(input: Record<string, unknown>): Checked<number> {
  const value = input.limit;
  if (value === undefined) return { ok: true, input: SEARCH_LIMIT_DEFAULT };
  if (typeof value !== "number" || !Number.isInteger(value) || value < SEARCH_LIMIT_MIN || value > SEARCH_LIMIT_MAX) {
    return {
      ok: false,
      result: {
        isError: true,
        content: `[memory] limit must be an integer from ${SEARCH_LIMIT_MIN} to ${SEARCH_LIMIT_MAX}`,
      },
    };
  }
  return { ok: true, input: value };
}

/** The note as `get` hands it over: every field the index and the reader need. */
function noteJson(note: MemoryNote): string {
  const { id, slug, type, scope, description, source, updatedAt, status, body } = note;
  return JSON.stringify({ id, slug, type, scope, description, source, updatedAt, status, body });
}

/** One note, read whole. An absent slug is the one answer that is not a note. */
async function runGet(host: MemoryHost, input: Record<string, unknown>): Promise<ToolResult> {
  const slug = slugOf(input);
  if (!slug.ok) return slug.result;
  const scope = scopeOf(input);
  if (!scope.ok) return scope.result;
  const note = await host.getNote(scope.input, slug.input);
  if (note === null) return { isError: true, content: `[memory] no note ${scope.input}/${slug.input}` };
  return { content: noteJson(note) };
}

/**
 * One keyword search. A request that names no scope is passed on without one, so
 * the host's own cross-scope search is what runs rather than a scope guessed here.
 */
async function runSearch(host: MemoryHost, input: Record<string, unknown>): Promise<ToolResult> {
  const text = stringOf(input, "text");
  if (!text.ok) return text.result;
  const scope = scopeOf(input);
  if (!scope.ok) return scope.result;
  const limit = limitOf(input);
  if (!limit.ok) return limit.result;
  const query: MemorySearchInput =
    input.scope === undefined
      ? { text: text.input, limit: limit.input }
      : { text: text.input, scope: scope.input, limit: limit.input };
  const hits: readonly MemoryHit[] = await host.search(query);
  return { content: JSON.stringify({ hits }) };
}

/** One save, checked for shape and then held until the write story lands. */
function runSave(input: Record<string, unknown>): ToolResult {
  for (const field of SAVE_REQUIRED_FIELDS) {
    const checked = stringOf(input, field);
    if (!checked.ok) return checked.result;
  }
  const scope = scopeOf(input);
  if (!scope.ok) return scope.result;
  return NOT_IMPLEMENTED;
}

/** One forget, checked for shape and then held until the write story lands. */
function runForget(input: Record<string, unknown>): ToolResult {
  const slug = slugOf(input);
  if (!slug.ok) return slug.result;
  const reason = stringOf(input, "reason");
  if (!reason.ok) return reason.result;
  const scope = scopeOf(input);
  if (!scope.ok) return scope.result;
  return NOT_IMPLEMENTED;
}

/**
 * Run one tool action, turning a throw into the result the model sees.
 *
 * A tool's contract is that it answers, never throws: a failing read is the
 * session's problem to work around, not a lost turn. The read tools report only
 * which of them failed and why; a write's own refusals are mapped where the write
 * lives.
 */
async function answer(tool: string, action: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await action();
  } catch (error) {
    return { isError: true, content: `[memory] ${tool} failed: ${errorMessage(error)}` };
  }
}

/** The `scope` property every tool's schema shares. */
const SCOPE_PROPERTY = { type: "string", enum: SCOPE_VALUES };

const GET_SCHEMA = {
  type: "object",
  properties: { slug: { type: "string" }, scope: SCOPE_PROPERTY },
  required: ["slug"],
  additionalProperties: false,
};

const SEARCH_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string" },
    scope: SCOPE_PROPERTY,
    limit: { type: "integer", minimum: SEARCH_LIMIT_MIN, maximum: SEARCH_LIMIT_MAX, default: SEARCH_LIMIT_DEFAULT },
  },
  required: ["text"],
  additionalProperties: false,
};

const SAVE_SCHEMA = {
  type: "object",
  properties: {
    slug: { type: "string" },
    type: { type: "string" },
    description: { type: "string" },
    body: { type: "string" },
    scope: SCOPE_PROPERTY,
  },
  required: [...SAVE_REQUIRED_FIELDS],
  additionalProperties: false,
};

const FORGET_SCHEMA = {
  type: "object",
  properties: { slug: { type: "string" }, reason: { type: "string" }, scope: SCOPE_PROPERTY },
  required: ["slug", "reason"],
  additionalProperties: false,
};

/**
 * The provider's four tools, in the order a session reads them: the two reads a
 * task starts with, then the two writes.
 */
function memoryTools(host: MemoryHost): readonly ProviderTool[] {
  return [
    {
      localName: "get",
      description: "Read one saved memory note in full, by its slug.",
      inputSchema: GET_SCHEMA,
      run: (input) => answer("get", () => runGet(host, input)),
    },
    {
      localName: "search",
      description: "Find saved memory notes by keyword.",
      inputSchema: SEARCH_SCHEMA,
      run: (input) => answer("search", () => runSearch(host, input)),
    },
    {
      localName: "save",
      description: "Save a note a future session would need: one fact, short.",
      inputSchema: SAVE_SCHEMA,
      run: async (input) => runSave(input),
    },
    {
      localName: "forget",
      description: "Retire a saved memory note that is wrong, with the reason.",
      inputSchema: FORGET_SCHEMA,
      run: async (input) => runForget(input),
    },
  ];
}

/**
 * Create the memory provider over one host.
 *
 * Static: the schemas above are written and reviewed in this repository, so they
 * are as trustworthy as a built-in tool's. Attached to every stage, because a
 * memory note is worth reading wherever an agent runs.
 *
 * @param host - The memory host every tool reads (and, once the writes land, writes) through
 */
export function createMemoryToolProvider(host: MemoryHost): ToolProvider {
  return {
    id: MEMORY_TOOL_PROVIDER_ID,
    kind: "static",
    stages: ["*"],
    instructions: async () => buildMemoryToolInstructions(),
    tools: async () => memoryTools(host),
  };
}
