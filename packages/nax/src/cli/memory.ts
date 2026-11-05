/**
 * `nax memory` — inspect the memory mirror from the terminal (spec US-016).
 *
 * A chat session reaches memory through its tools and `/memory`; a terminal that is not in a
 * chat session has neither, so this group is the other surface. This file registers the group
 * and holds the two listing subcommands — `status` reports what the mirror holds, `list`
 * prints what it holds — while the other files beside it add their own: `memory-read.ts`
 * (`show`, `sync`), `memory-write.ts` (`save`, `forget`, `approve`) and `memory-admin.ts`
 * (`link`).
 *
 * The command is a thin shell, as `nax cost` is: the plumbing every subcommand shares — the
 * `--dir` / `--json` flags, the repository-root resolution, the host and the error contract —
 * lives in `memory-cli-deps.ts`, and what is left here is the ordering a listing promises.
 *
 * It takes no trust gate and does not call `initLogger`: it reads and writes only under
 * `~/.nax/memory`, and stdout belongs to the command's own output — the `--json`
 * single-document promise with it. A disabled mirror is the one failure `status` answers as
 * data instead — `enabled: false`, exit 0 — because "memory is off" is exactly what `status`
 * exists to report.
 */
import type { MemoryNote, MemoryNoteType, MemoryScope } from "@nathapp/nax-agent";
import { byCodePoint } from "@nathapp/nax-agent/internal";
import type { Command } from "commander";
import { formatMemoryNoteLine, formatMemoryStatus, type MemoryHost, pendingForgetKey } from "@/memory";
import { registerMemoryAdminCommands } from "./memory-admin";
import {
  _memoryCliDeps,
  type MemoryCliDeps,
  type MemoryCliOptions,
  memoryContext,
  memoryDefaultDir,
  memoryDisabledError,
  NOTE_SCOPES,
  NOTE_TYPES,
  parseNoteScope,
  parseNoteType,
  withMemoryErrors,
  withMemoryHost,
} from "./memory-cli-deps";
import { registerMemoryReadCommands } from "./memory-read";
import { registerMemoryRequeueCommand } from "./memory-requeue";
import { registerMemoryWriteCommands } from "./memory-write";

/** What `list` takes on top of the group's flags: one note type and one scope, both optional. */
export interface MemoryListOptions extends MemoryCliOptions {
  readonly type?: string;
  readonly scope?: string;
}

/**
 * The order a listing is served in: the project's own notes first, then the machine's.
 * Within a scope the rows are slug order, which is the host's own order for one scope.
 */
const SCOPE_ORDER: readonly MemoryScope[] = NOTE_SCOPES;

/** Project notes before user notes, then slug order: the order a listing is served in. */
function compareByScopeThenSlug(left: MemoryNote, right: MemoryNote): number {
  const byScope = SCOPE_ORDER.indexOf(left.scope) - SCOPE_ORDER.indexOf(right.scope);
  return byScope === 0 ? byCodePoint(left.slug, right.slug) : byScope;
}

/** The notes a listing prints: one scope, or the project's followed by the machine's. */
async function readListing(host: MemoryHost, scope: MemoryScope | undefined): Promise<readonly MemoryNote[]> {
  const notes =
    scope === undefined ? [...(await host.notes("project")), ...(await host.notes("user"))] : await host.notes(scope);
  return [...notes].sort(compareByScopeThenSlug);
}

/** One listing entry: every field a row names, without the body a listing never prints. */
export type MemoryNoteListing = Omit<MemoryNote, "body">;

function listingEntry(note: MemoryNote): MemoryNoteListing {
  const { id, slug, type, scope, description, source, updatedAt, status } = note;
  return { id, slug, type, scope, description, source, updatedAt, status };
}

/** The notes of one type, or every note when the flag named none. */
function ofType(notes: readonly MemoryNote[], type: MemoryNoteType | undefined): readonly MemoryNote[] {
  return type === undefined ? notes : notes.filter((note) => note.type === type);
}

/** What a row ends with when the host reports a forget for its note still pending. */
const FORGET_PENDING_SUFFIX = " (forget pending)";

/** The line an empty listing prints: nothing to list at all, or nothing the flags matched. */
const NO_NOTES_LINE = "no memory notes";
const NO_MATCHED_NOTES_LINE = "no memory notes match";

/** What a host without `forgetPendingKeys` holds: the member is optional, and marks no row. */
const NO_PENDING_FORGETS: ReadonlySet<string> = new Set();

/**
 * The keys the host reports a forget still pending for, read now.
 *
 * A host that does not report them at all — a hand-built double — is one whose rows are
 * unmarked, rather than a listing that fails.
 */
async function pendingForgetKeysOf(host: MemoryHost): Promise<ReadonlySet<string>> {
  return host.forgetPendingKeys === undefined ? NO_PENDING_FORGETS : await host.forgetPendingKeys();
}

/** One listing row: the note's line, marked when a forget for it is still pending. */
function listingLine(note: MemoryNote, pendingForgets: ReadonlySet<string>): string {
  const line = formatMemoryNoteLine(note);
  return pendingForgets.has(pendingForgetKey(note)) ? `${line}${FORGET_PENDING_SUFFIX}` : line;
}

/** The line an empty listing prints, named after whether a flag narrowed it. */
function emptyListingLine(narrowed: boolean): string {
  return narrowed ? NO_MATCHED_NOTES_LINE : NO_NOTES_LINE;
}

/**
 * `nax memory status`: what the mirror holds, or `enabled: false` when memory is off.
 *
 * A disabled mirror is not an error here — it is the answer. Every other outcome, including
 * an unloadable config and a host that cannot be composed, is the group's error contract.
 */
export async function memoryStatusCommand(
  opts: MemoryCliOptions,
  deps: MemoryCliDeps = _memoryCliDeps,
): Promise<number> {
  return withMemoryErrors(
    async () =>
      withMemoryHost(await memoryContext(opts.dir, deps), deps, async (host) => {
        if (host === null) {
          deps.log(opts.json === true ? JSON.stringify({ enabled: false }) : "enabled: false");
          return 0;
        }
        const status = await host.status();
        deps.log(opts.json === true ? JSON.stringify(status) : formatMemoryStatus(status));
        return 0;
      }),
    deps,
  );
}

/**
 * `nax memory list`: one row per note, project notes first then the machine's, each by slug.
 *
 * The flags are checked before the host is opened, so a typo in `--type` costs no read. Under
 * `--json` the rows are the document — each entry carries the note's fields but not its body,
 * which a listing never prints and no consumer of the list needs. A row whose note has a forget
 * still pending says so on the row itself, and a listing with nothing to print says which kind
 * of nothing it is: an empty mirror, or flags that matched none of it.
 */
export async function memoryListCommand(
  opts: MemoryListOptions,
  deps: MemoryCliDeps = _memoryCliDeps,
): Promise<number> {
  return withMemoryErrors(async () => {
    const type = parseNoteType(opts.type);
    const scope = parseNoteScope(opts.scope);
    return withMemoryHost(await memoryContext(opts.dir, deps), deps, async (host) => {
      if (host === null) throw memoryDisabledError();
      const notes = ofType(await readListing(host, scope), type);
      if (opts.json === true) {
        deps.log(JSON.stringify({ notes: notes.map(listingEntry) }));
        return 0;
      }
      if (notes.length === 0) {
        deps.log(emptyListingLine(type !== undefined || scope !== undefined));
        return 0;
      }
      const pendingForgets = await pendingForgetKeysOf(host);
      for (const note of notes) deps.log(listingLine(note, pendingForgets));
      return 0;
    });
  }, deps);
}

/**
 * Register `nax memory` and its subcommands.
 *
 * Deliberately does not call `initLogger` and takes no trust gate, for the reason `nax cost`
 * does not: the command reads the mirror under `~/.nax/memory` and writes nothing to the
 * repository, so stdout carries the report and the `--json` document stays the only line.
 */
export function registerMemoryCommand(program: Command, deps: MemoryCliDeps = _memoryCliDeps): Command {
  const memory = program.command("memory").description("Inspect the memory notes earlier sessions saved");
  memory
    .command("status")
    .description("Report what the memory mirror holds")
    .option("-d, --dir <path>", "Project directory", memoryDefaultDir())
    .option("--json", "Emit one machine-readable document", false)
    .action(async (opts: MemoryCliOptions) => {
      deps.exit(await memoryStatusCommand(opts, deps));
    });
  memory
    .command("list")
    .description("List saved memory notes, project notes first then user notes")
    .option("--type <type>", `Only notes of one type: ${NOTE_TYPES.join(", ")}`)
    .option("--scope <scope>", `Only notes in one scope: ${NOTE_SCOPES.join(", ")}`)
    .option("-d, --dir <path>", "Project directory", memoryDefaultDir())
    .option("--json", "Emit one machine-readable document", false)
    .action(async (opts: MemoryListOptions) => {
      deps.exit(await memoryListCommand(opts, deps));
    });
  registerMemoryReadCommands(memory, deps);
  registerMemoryWriteCommands(memory, deps);
  registerMemoryAdminCommands(memory, deps);
  registerMemoryRequeueCommand(memory, deps);
  return memory;
}
