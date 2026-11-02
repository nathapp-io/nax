/**
 * `nax memory save` — write one note from the terminal (spec US-018).
 *
 * A session saves notes through the `save` tool; a terminal that is not in a session has
 * no tool, so this subcommand is the other way in. It takes the note's four fields as flags
 * and its body either inline (`--body`) or from a file (`--body-file`), and hands the whole
 * write to the host, which is the only writer.
 *
 * What a note may contain is not decided here. `saveMemoryNote` validates it — the type, the
 * lengths, the secret scan — and refuses with `MEMORY_WRITE_REFUSED`, so an invalid `--type`
 * surfaces as the store's refusal rather than as a flag error: the same rule then answers a
 * terminal save and an agent's, and there is one message to learn. The flags this file does
 * check are the two the store cannot see: that exactly one body input was given, and that
 * `--scope` names a scope the mirror has.
 *
 * The line a save prints is what became of the note, not what was asked for: the status the
 * store settled on (`active` under `direct`, `pending` under `proposal`) and, when the note
 * is still waiting for a sync to deliver it, that it is queued. A queued save is a success —
 * the note is in the mirror and the next sync sends it — so it exits 0, as the mirror's own
 * design intends.
 */
import type { MemoryNoteType, MemoryNoteWrite, MemorySaveResult, MemoryScope } from "@nathapp/nax-agent";
import type { Command } from "commander";
import { NaxError } from "@/errors";
import {
  _memoryCliDeps,
  type MemoryCliDeps,
  type MemoryCliOptions,
  memoryContext,
  memoryDefaultDir,
  memoryDisabledError,
  NOTE_SCOPES,
  NOTE_TYPES,
  openMemoryHost,
  parseNoteScope,
  withMemoryErrors,
} from "./memory-cli-deps";

/** The scope a save lands in when `--scope` is not given: the project's own mirror. */
const DEFAULT_SAVE_SCOPE: MemoryScope = "project";

/** The suffix a note still waiting for a sync is reported with. */
const QUEUED_SUFFIX = " — queued for sync";

/** What `save` takes on top of the group's flags: the note's fields and its one body input. */
export interface MemorySaveOptions extends MemoryCliOptions {
  readonly slug: string;
  readonly type: string;
  readonly description: string;
  readonly body?: string;
  readonly bodyFile?: string;
  readonly scope?: string;
}

/** The one body input a save was given: the text itself, or the path to read it from. */
type BodyInput = { readonly from: "inline"; readonly text: string } | { readonly from: "file"; readonly path: string };

/** The usage error the two body flags share: one of them, and never both or neither. */
function bodyInputError(): NaxError {
  return new NaxError("give exactly one of --body or --body-file", "MEMORY_CLI_USAGE", { stage: "memory" });
}

/**
 * The body input the flags name, or the usage error when they name none or both.
 *
 * An empty `--body ""` counts as given: the operator asked for an empty body, which is a
 * body the store may keep, rather than for no body at all.
 */
function bodyInputOf(opts: MemorySaveOptions): BodyInput {
  const { body, bodyFile } = opts;
  if (body !== undefined && bodyFile === undefined) return { from: "inline", text: body };
  if (bodyFile !== undefined && body === undefined) return { from: "file", path: bodyFile };
  throw bodyInputError();
}

/** The body text itself: inline as given, or the file's text through the group's seam. */
async function bodyTextOf(input: BodyInput, deps: MemoryCliDeps): Promise<string> {
  return input.from === "inline" ? input.text : await deps.readFile(input.path);
}

/**
 * The note type the operator named, as the store's own vocabulary.
 *
 * The four types are the store's model and `saveMemoryNote` is what refuses a value outside
 * it (`MEMORY_WRITE_REFUSED`, field `type`), so the flag is not re-checked here — narrowing
 * it in the type system would leave the store's refusal unreachable from the terminal. The
 * same cast, for the same reason, is in `tool-provider.ts`'s `noteTypeOf`.
 */
function noteTypeOf(type: string): MemoryNoteType {
  return type as MemoryNoteType;
}

/** One save's write: the flags the operator gave, stamped with the scope it lands in. */
function saveWriteOf(opts: MemorySaveOptions, scope: MemoryScope, body: string): MemoryNoteWrite {
  return {
    slug: opts.slug,
    type: noteTypeOf(opts.type),
    scope,
    description: opts.description,
    body,
  };
}

/** The line one save prints: what was stored, the status it settled on, and any queued wait. */
function formatSaveLine(scope: MemoryScope, result: MemorySaveResult): string {
  const saved = `saved ${scope}/${result.slug} (${result.status})`;
  return result.delivered ? saved : `${saved}${QUEUED_SUFFIX}`;
}

/**
 * `nax memory save …`: store one note, and print what became of it.
 *
 * The two flag checks come before the host is opened — an operator who named two bodies, or
 * a scope the mirror does not have, has not asked for a write — and the body file is read
 * only once the host exists, so a disabled mirror is reported as disabled rather than as a
 * missing file. Everything the store refuses (`MEMORY_WRITE_REFUSED`, and any other failure)
 * is the group's error contract: one `Error: <message>` line on stderr and exit 1.
 */
export async function memorySaveCommand(
  opts: MemorySaveOptions,
  deps: MemoryCliDeps = _memoryCliDeps,
): Promise<number> {
  return withMemoryErrors(async () => {
    const scope = parseNoteScope(opts.scope) ?? DEFAULT_SAVE_SCOPE;
    const bodyInput = bodyInputOf(opts);
    const host = await openMemoryHost(await memoryContext(opts.dir, deps), deps);
    if (host === null) throw memoryDisabledError();
    const result = await host.save(saveWriteOf(opts, scope, await bodyTextOf(bodyInput, deps)));
    deps.log(opts.json === true ? JSON.stringify(result) : formatSaveLine(scope, result));
    return 0;
  }, deps);
}

/**
 * Register `save` on the `memory` group.
 *
 * The group itself is registered by `memory.ts`; this file adds the subcommand that writes,
 * and takes the group's deps seam so a stubbed `exit`, `readFile` or `createMemoryHost`
 * reaches it unchanged.
 */
export function registerMemoryWriteCommands(memory: Command, deps: MemoryCliDeps = _memoryCliDeps): Command {
  memory
    .command("save")
    .description("Save one memory note from inline text or a file")
    .requiredOption("--slug <slug>", "The note's slug")
    .requiredOption("--type <type>", `The note's type: ${NOTE_TYPES.join(", ")}`)
    .requiredOption("--description <text>", "One line describing the note")
    .option("--body <text>", "The note's body, inline")
    .option("--body-file <path>", "The note's body, read from this file")
    .option("--scope <scope>", `The scope to save into: ${NOTE_SCOPES.join(", ")}`, DEFAULT_SAVE_SCOPE)
    .option("-d, --dir <path>", "Project directory", memoryDefaultDir())
    .option("--json", "Emit one machine-readable document", false)
    .action(async (opts: MemorySaveOptions) => {
      deps.exit(await memorySaveCommand(opts, deps));
    });
  return memory;
}
