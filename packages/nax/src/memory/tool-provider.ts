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
 * save is validated once, where the note is written. The schema each tool advertises
 * states what those checks enforce — `minLength: 1` on every required string, and the
 * store's own pattern where the slug is checked here — so a value the schema admits is
 * a value the tool answers rather than one it refuses.
 *
 * `get` takes a slug and never an id: ids are the provider's own, and the index a
 * session reads lists slugs. `save` and `forget` hand the host the note the model
 * wrote and the reason it gave, and answer with the result the host resolved —
 * whose validation is the store's, so a refusal arrives here as the reason it was
 * refused rather than as a second, weaker check kept in this file.
 *
 * Every throw becomes a line the model can act on, never a rejected tool: a note
 * the repository owns is reported with the file to edit, a refused write with the
 * validator's reason, a missing note as the same `no note` line `get` answers with,
 * and anything else as `<tool> failed: <message>`.
 */
import type {
  MemoryHit,
  MemoryNote,
  MemoryNoteType,
  MemoryNoteWrite,
  MemoryScope,
  ProviderTool,
  ToolProvider,
  ToolResult,
} from "@nathapp/nax-agent";
import { MEMORY_SLUG_RE } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
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

/** The line a tool answers with when the note its request named is not there. */
function noNote(scope: MemoryScope, slug: string): ToolResult {
  return { isError: true, content: `[memory] no note ${scope}/${slug}` };
}

/** The four strings a save cannot be called without, in the order its schema lists them. */
interface SaveFields {
  readonly slug: string;
  readonly type: string;
  readonly description: string;
  readonly body: string;
}

/** The four strings a save was given, or the refusal of the first one the request left out. */
function saveFieldsOf(input: Record<string, unknown>): Checked<SaveFields> {
  const slug = stringOf(input, "slug");
  if (!slug.ok) return slug;
  const type = stringOf(input, "type");
  if (!type.ok) return type;
  const description = stringOf(input, "description");
  if (!description.ok) return description;
  const body = stringOf(input, "body");
  if (!body.ok) return body;
  return { ok: true, input: { slug: slug.input, type: type.input, description: description.input, body: body.input } };
}

/**
 * The note type the model named, as the store's own vocabulary.
 *
 * The four types are the store's model and `saveMemoryNote` is what refuses a value
 * outside it, so the string is handed on rather than a second copy of the list being
 * kept here: a note is validated once, where it is written.
 */
function noteTypeOf(type: string): MemoryNoteType {
  return type as MemoryNoteType;
}

/** One save's write: the fields the model gave, stamped with the scope it named. */
function saveWriteOf(fields: SaveFields, scope: MemoryScope): MemoryNoteWrite {
  return {
    slug: fields.slug,
    type: noteTypeOf(fields.type),
    scope,
    description: fields.description,
    body: fields.body,
  };
}

/** One note, read whole. An absent slug is the one answer that is not a note. */
async function runGet(host: MemoryHost, input: Record<string, unknown>): Promise<ToolResult> {
  const slug = slugOf(input);
  if (!slug.ok) return slug.result;
  const scope = scopeOf(input);
  if (!scope.ok) return scope.result;
  const note = await host.getNote(scope.input, slug.input);
  if (note === null) return noNote(scope.input, slug.input);
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

/** One save: the note the model wrote, written where its content is validated. */
async function runSave(host: MemoryHost, input: Record<string, unknown>): Promise<ToolResult> {
  const fields = saveFieldsOf(input);
  if (!fields.ok) return fields.result;
  const scope = scopeOf(input);
  if (!scope.ok) return scope.result;
  const result = await host.save(saveWriteOf(fields.input, scope.input));
  return { content: JSON.stringify(result) };
}

/** One forget: the note to retire, why, and the scope it lives in. */
async function runForget(host: MemoryHost, input: Record<string, unknown>): Promise<ToolResult> {
  const slug = slugOf(input);
  if (!slug.ok) return slug.result;
  const reason = stringOf(input, "reason");
  if (!reason.ok) return reason.result;
  const scope = scopeOf(input);
  if (!scope.ok) return scope.result;
  const result = await host.forget({ scope: scope.input, slug: slug.input, reason: reason.input });
  return { content: JSON.stringify(result) };
}

/**
 * The result a throw becomes: the refusals the model can act on, then everything else.
 *
 * A note the repository owns is reported with the host's own message, which names the
 * file to edit; a write the store refused is reported as the refusal it is, with the
 * validator's reason; a note that is not there is the same `no note` line `get` answers
 * with. Anything else — a full disk, a lock that would not wait — is named by the tool
 * that failed, so a session knows which call not to repeat.
 */
function failure(tool: string, input: Record<string, unknown>, error: unknown): ToolResult {
  const code = error instanceof NaxError ? error.code : undefined;
  if (code === "MEMORY_NOTE_READ_ONLY") return { isError: true, content: `[memory] ${errorMessage(error)}` };
  if (code === "MEMORY_WRITE_REFUSED")
    return { isError: true, content: `[memory] save refused: ${errorMessage(error)}` };
  const scope = scopeOf(input);
  const slug = slugOf(input);
  if (code === "MEMORY_NOTE_NOT_FOUND" && scope.ok && slug.ok) return noNote(scope.input, slug.input);
  return { isError: true, content: `[memory] ${tool} failed: ${errorMessage(error)}` };
}

/**
 * Run one tool action, turning a throw into the result the model sees.
 *
 * A tool's contract is that it answers, never throws: a failing read or a refused
 * write is the session's problem to work around, not a lost turn.
 */
async function answer(
  tool: string,
  input: Record<string, unknown>,
  action: () => Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    return await action();
  } catch (error) {
    return failure(tool, input, error);
  }
}

/** The `scope` property every tool's schema shares. */
const SCOPE_PROPERTY = { type: "string", enum: SCOPE_VALUES };

/**
 * A required string the tools refuse when it is empty.
 *
 * `stringOf` is the check that refuses `""`, so the schema says so too: a schema that admits
 * the empty string advertises an input the tool then answers with `[memory] invalid …`, which
 * is a contract the model cannot read off the tool it was given.
 */
const REQUIRED_TEXT = { type: "string", minLength: 1 };

/**
 * A required slug, spelled with the store's own pattern.
 *
 * `get` and `forget` check the slug against `MEMORY_SLUG_RE` before the host is asked, so the
 * schema carries that same expression rather than a second copy of the rule. `save` does not:
 * its slug is validated where the note is written (`saveMemoryNote`), so there the field is
 * `REQUIRED_TEXT` and a bad slug arrives as the store's refusal, not as a shape error.
 */
const REQUIRED_SLUG = { type: "string", minLength: 1, pattern: MEMORY_SLUG_RE.source };

const GET_SCHEMA = {
  type: "object",
  properties: { slug: REQUIRED_SLUG, scope: SCOPE_PROPERTY },
  required: ["slug"],
  additionalProperties: false,
};

const SEARCH_SCHEMA = {
  type: "object",
  properties: {
    text: REQUIRED_TEXT,
    scope: SCOPE_PROPERTY,
    limit: { type: "integer", minimum: SEARCH_LIMIT_MIN, maximum: SEARCH_LIMIT_MAX, default: SEARCH_LIMIT_DEFAULT },
  },
  required: ["text"],
  additionalProperties: false,
};

const SAVE_SCHEMA = {
  type: "object",
  properties: {
    slug: REQUIRED_TEXT,
    type: REQUIRED_TEXT,
    description: REQUIRED_TEXT,
    body: REQUIRED_TEXT,
    scope: SCOPE_PROPERTY,
  },
  required: [...SAVE_REQUIRED_FIELDS],
  additionalProperties: false,
};

const FORGET_SCHEMA = {
  type: "object",
  properties: { slug: REQUIRED_SLUG, reason: REQUIRED_TEXT, scope: SCOPE_PROPERTY },
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
      run: (input) => answer("get", input, () => runGet(host, input)),
    },
    {
      localName: "search",
      description: "Find saved memory notes by keyword.",
      inputSchema: SEARCH_SCHEMA,
      run: (input) => answer("search", input, () => runSearch(host, input)),
    },
    {
      localName: "save",
      description: "Save a note a future session would need: one fact, short.",
      inputSchema: SAVE_SCHEMA,
      run: (input) => answer("save", input, () => runSave(host, input)),
    },
    {
      localName: "forget",
      description: "Retire a saved memory note that is wrong, with the reason.",
      inputSchema: FORGET_SCHEMA,
      run: (input) => answer("forget", input, () => runForget(host, input)),
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
 * @param host - The memory host every tool reads and writes through
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
