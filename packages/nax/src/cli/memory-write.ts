/**
 * `nax memory save`, `nax memory forget` and `nax memory approve` — the writes a terminal
 * can make (spec US-018, US-019).
 *
 * A session writes through its tools; a terminal that is not in a session has none, so these
 * three subcommands are the other way in, and each hands the whole write to the host, which is
 * the only writer.
 *
 * `save` takes the note's four fields as flags and its body either inline (`--body`) or from a
 * file (`--body-file`). What a note may contain is not decided here: `saveMemoryNote` validates
 * it — the type, the lengths, the secret scan — and refuses with `MEMORY_WRITE_REFUSED`, so an
 * invalid `--type` surfaces as the store's refusal rather than as a flag error: the same rule
 * then answers a terminal save and an agent's, and there is one message to learn. The flags this
 * file does check are the two the store cannot see: that exactly one body input was given, and
 * that `--scope` names a scope the mirror has.
 *
 * `forget` retires one note and records why, and `approve` puts a pending one in force. Both are
 * refused for a slug only a repository note holds (`MEMORY_NOTE_READ_ONLY`, which names the file
 * to edit), and both answer an absent slug with the terminal's own `no memory note <scope>/<slug>`
 * rather than the store's in-session wording — the one translation this file makes, keyed on the
 * error code rather than on a message.
 *
 * The line a save prints is what became of the note, not what was asked for: the status the store
 * settled on (`active` under `direct`, `pending` under `proposal`) and, when the note is still
 * waiting for a sync to deliver it, that it is queued. A queued save is a success — the note is in
 * the mirror and the next sync sends it — so it exits 0, as the mirror's own design intends. A
 * forget prints the note it retired and the status it settled on; an approval prints the note that
 * is now in force.
 */
import {
  MEMORY_FORGET_REASON_MAX_CHARS,
  type MemoryForgetResult,
  type MemoryNoteType,
  type MemoryNoteWrite,
  type MemorySaveResult,
  type MemoryScope,
} from "@nathapp/nax-agent";
import type { Command } from "commander";
import { NaxError } from "@/errors";
import {
  _memoryCliDeps,
  type MemoryCliDeps,
  type MemoryCliOptions,
  memoryContext,
  memoryDefaultDir,
  memoryDisabledError,
  memoryNoteAbsentError,
  NOTE_SCOPES,
  NOTE_TYPES,
  openMemoryHost,
  parseNoteScope,
  withMemoryErrors,
} from "./memory-cli-deps";

/** The scope a write lands in when `--scope` is not given: the project's own mirror. */
const DEFAULT_WRITE_SCOPE: MemoryScope = "project";

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
    const scope = parseNoteScope(opts.scope) ?? DEFAULT_WRITE_SCOPE;
    const bodyInput = bodyInputOf(opts);
    const host = await openMemoryHost(await memoryContext(opts.dir, deps), deps);
    if (host === null) throw memoryDisabledError();
    const result = await host.save(saveWriteOf(opts, scope, await bodyTextOf(bodyInput, deps)));
    deps.log(opts.json === true ? JSON.stringify(result) : formatSaveLine(scope, result));
    return 0;
  }, deps);
}

/**
 * What `forget` takes on top of the group's flags: why the note is being retired, and where.
 */
export interface MemoryForgetOptions extends MemoryCliOptions {
  readonly reason?: string;
  readonly scope?: string;
}

/** What `approve` takes on top of the group's flags: the scope the pending note lives in. */
export interface MemoryApproveOptions extends MemoryCliOptions {
  readonly scope?: string;
}

/** The usage error a `forget` with no reason answers with: a retirement says why. */
function reasonMissingError(): NaxError {
  return new NaxError("forget requires a reason (--reason <text>)", "MEMORY_CLI_USAGE", { stage: "memory" });
}

/** The usage error a `forget` whose reason runs past the store's cap answers with. */
function reasonTooLongError(): NaxError {
  return new NaxError(
    `forget reason must be at most ${MEMORY_FORGET_REASON_MAX_CHARS} characters`,
    "MEMORY_CLI_USAGE",
    {
      stage: "memory",
    },
  );
}

/**
 * The reason the operator gave, or the usage error when they gave none or too much.
 *
 * A blank `--reason "  "` counts as none, as the tool's own check does: the reason is what a
 * later session reads to know why a note went, and an empty one records nothing. Unlike
 * `--body ""`, which the store may legitimately keep, there is no such thing as an empty
 * explanation.
 *
 * The cap is the store's own (`MEMORY_FORGET_REASON_MAX_CHARS`), so the terminal and the
 * mirror agree on one number rather than the CLI inventing a second, weaker bound. It is
 * applied here, before the host is opened, so an over-long justification costs no repository
 * walk and no write — and `forgetMemoryNote` refuses it too, so neither surface can persist one.
 */
function reasonOf(opts: MemoryForgetOptions): string {
  const reason = opts.reason;
  if (reason === undefined || reason.trim() === "") throw reasonMissingError();
  if (reason.length > MEMORY_FORGET_REASON_MAX_CHARS) throw reasonTooLongError();
  return reason;
}

/**
 * Run one write, re-wording the one refusal the terminal says differently.
 *
 * Feature 1 answers an absent slug with `MEMORY_NOTE_NOT_FOUND` and its own message, written
 * for a caller inside a session; the terminal's is the group's `no memory note <scope>/<slug>`.
 * Matching the code rather than the message keeps that translation in one place, and every
 * other throw — a repository note with the file to edit, a refusal with the validator's
 * reason — reaches the error contract unchanged.
 */
async function orAbsentNote<T>(scope: MemoryScope, slug: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof NaxError && error.code === "MEMORY_NOTE_NOT_FOUND") throw memoryNoteAbsentError(scope, slug);
    throw error;
  }
}

/** The line one forget prints: what was retired, and the status it settled on. */
function formatForgetLine(scope: MemoryScope, result: MemoryForgetResult): string {
  return `forgot ${scope}/${result.slug} (${result.status})`;
}

/**
 * `nax memory forget <slug> --reason <text>`: retire one note and print what became of it.
 *
 * The two flag checks come before the host is opened — an operator who named no reason, or a
 * scope the mirror does not have, has not asked for a retirement — and a disabled mirror is
 * answered before any read, so a mirror that is off costs no repository walk. Under `proposal`
 * the note stays in place with a pending forget, which the line reports as the status it
 * settled on rather than as a deletion that did not happen: completing that proposal is not a
 * command yet.
 */
export async function memoryForgetCommand(
  slug: string,
  opts: MemoryForgetOptions,
  deps: MemoryCliDeps = _memoryCliDeps,
): Promise<number> {
  return withMemoryErrors(async () => {
    const scope = parseNoteScope(opts.scope) ?? DEFAULT_WRITE_SCOPE;
    const reason = reasonOf(opts);
    const host = await openMemoryHost(await memoryContext(opts.dir, deps), deps);
    if (host === null) throw memoryDisabledError();
    const result = await orAbsentNote(scope, slug, () => host.forget({ scope, slug, reason }));
    deps.log(opts.json === true ? JSON.stringify(result) : formatForgetLine(scope, result));
    return 0;
  }, deps);
}

/**
 * `nax memory approve <slug>`: put a pending note in force, and print the note.
 *
 * Approval changes a pending note to active inside the mirror; it is not the approval of a
 * queued forget, which no command offers. `--json` prints the note the store resolved, so the
 * status the approval settled on is the document's own field rather than a word this file chose.
 */
export async function memoryApproveCommand(
  slug: string,
  opts: MemoryApproveOptions,
  deps: MemoryCliDeps = _memoryCliDeps,
): Promise<number> {
  return withMemoryErrors(async () => {
    const scope = parseNoteScope(opts.scope) ?? DEFAULT_WRITE_SCOPE;
    const host = await openMemoryHost(await memoryContext(opts.dir, deps), deps);
    if (host === null) throw memoryDisabledError();
    const note = await orAbsentNote(scope, slug, () => host.approve({ scope, slug }));
    deps.log(opts.json === true ? JSON.stringify(note) : `approved ${note.scope}/${note.slug}`);
    return 0;
  }, deps);
}

/**
 * Register `save`, `forget` and `approve` on the `memory` group.
 * The group itself is registered by `memory.ts`; this file adds the subcommands that write,
 * and takes the group's deps seam so a stubbed `exit`, `readFile` or `createMemoryHost`
 * reaches them unchanged.
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
    .option("--scope <scope>", `The scope to save into: ${NOTE_SCOPES.join(", ")}`, DEFAULT_WRITE_SCOPE)
    .option("-d, --dir <path>", "Project directory", memoryDefaultDir())
    .option("--json", "Emit one machine-readable document", false)
    .action(async (opts: MemorySaveOptions) => {
      deps.exit(await memorySaveCommand(opts, deps));
    });
  memory
    .command("forget")
    .description("Retire one memory note, recording why")
    .argument("<slug>", "The note's slug")
    .option("--reason <text>", "Why the note is being retired")
    .option("--scope <scope>", `The scope to forget in: ${NOTE_SCOPES.join(", ")}`, DEFAULT_WRITE_SCOPE)
    .option("-d, --dir <path>", "Project directory", memoryDefaultDir())
    .option("--json", "Emit one machine-readable document", false)
    .action(async (slug: string, opts: MemoryForgetOptions) => {
      deps.exit(await memoryForgetCommand(slug, opts, deps));
    });
  memory
    .command("approve")
    .description("Put a pending memory note in force")
    .argument("<slug>", "The note's slug")
    .option("--scope <scope>", `The scope to approve in: ${NOTE_SCOPES.join(", ")}`, DEFAULT_WRITE_SCOPE)
    .option("-d, --dir <path>", "Project directory", memoryDefaultDir())
    .option("--json", "Emit one machine-readable document", false)
    .action(async (slug: string, opts: MemoryApproveOptions) => {
      deps.exit(await memoryApproveCommand(slug, opts, deps));
    });
  return memory;
}
