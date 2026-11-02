/**
 * `nax memory` — inspect the memory mirror from the terminal (spec US-016).
 *
 * A chat session reaches memory through its tools and `/memory`; a terminal that is not in a
 * chat session has neither, so this group is the other surface. It starts with the two
 * read-only subcommands — `status` reports what the mirror holds, `list` prints what it holds
 * — and later stories add `show`, `sync`, `save`, `forget` and `approve` to the same group.
 *
 * The command is a thin shell, as `nax cost` is: it resolves the repository root the way
 * `nax chat` resolves it (the nearest `.nax` above `--dir`, else `--dir`), hands the host the
 * config it loaded plus a logger for the terminal, and prints what the host answers. It takes
 * no trust gate and does not call `initLogger`: it reads and writes only under `~/.nax/memory`,
 * and stdout belongs to the command's own output — the `--json` single-document promise with it.
 *
 * One error contract for every subcommand, present and future: anything thrown is
 * `Error: <message>` on stderr (also under `--json`) and exit 1. A disabled mirror is the one
 * failure `status` answers as data instead — `enabled: false`, exit 0 — because "memory is
 * off" is exactly what `status` exists to report.
 */
import { dirname } from "node:path";
import type { MemoryNote, MemoryNoteType, MemoryScope } from "@nathapp/nax-agent";
import { byCodePoint, errorMessage } from "@nathapp/nax-agent/internal";
import type { Command } from "commander";
import { findProjectDir, loadConfig, type NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import {
  createMemoryHost,
  formatMemoryNoteLine,
  formatMemoryStatus,
  type MemoryHost,
  type MemoryLogger,
} from "@/memory";

/** The label a note the CLI writes records as its origin: a person, not an agent or a run. */
const MEMORY_CLI_SOURCE = "human";

/**
 * The note types a `--type` accepts, and the two scopes a `--scope` does.
 *
 * The store's vocabulary, typed by the package's own `MemoryNoteType` / `MemoryScope`, so a
 * value outside it does not compile. The list is spelled here because `@nathapp/nax-agent`'s
 * root entry exports the types but not the arrays — the same reason `tool-provider.ts` spells
 * `SCOPE_VALUES` for the tools' schemas.
 */
const NOTE_TYPES = ["user", "feedback", "project", "reference"] as const satisfies readonly MemoryNoteType[];
const NOTE_SCOPES = ["project", "user"] as const satisfies readonly MemoryScope[];

/**
 * The order a listing is served in: the project's own notes first, then the machine's.
 * Within a scope the rows are slug order, which is the host's own order for one scope.
 */
const SCOPE_ORDER: readonly MemoryScope[] = NOTE_SCOPES;

/** What every `memory` subcommand takes: the directory it acts on, and the JSON switch. */
export interface MemoryCliOptions {
  readonly dir: string;
  readonly json?: boolean;
}

/** What `list` takes on top: one note type and one scope, both optional. */
export interface MemoryListOptions extends MemoryCliOptions {
  readonly type?: string;
  readonly scope?: string;
}

/** What a subcommand acts on: the config it loaded, and the repository it is rooted at. */
export interface MemoryCliContext {
  readonly config: NaxConfig;
  readonly repoRoot: string;
}

/**
 * The seam this group's every external call goes through: the repository walk, the config
 * load, the host and the file read `save --body-file` will take, plus the two output
 * channels. `readFile` has no caller in this story — it is declared here so the group has one
 * seam rather than two.
 */
export interface MemoryCliDeps {
  log: (msg: string) => void;
  logErr: (msg: string) => void;
  exit: (code: number) => void;
  findProjectDir: typeof findProjectDir;
  loadConfig: typeof loadConfig;
  createMemoryHost: typeof createMemoryHost;
  readFile: (path: string) => Promise<string>;
}

/** The real process: the report on stdout, `Error: <message>` and `[memory] …` on stderr. */
export const _memoryCliDeps: MemoryCliDeps = {
  log: (msg) => {
    console.log(msg);
  },
  logErr: (msg) => {
    console.error(msg);
  },
  exit: (code) => {
    process.exit(code);
  },
  findProjectDir,
  loadConfig,
  createMemoryHost,
  readFile: (path) => Bun.file(path).text(),
};

/**
 * The logger the host and its repository reads write through.
 *
 * A rejected repo note is the user's to fix — a committed file that broke a rule — so `warn`
 * and `error` are lines on the terminal. `info` and `debug` are dropped: they are the host's
 * internals, and stdout is the command's own output.
 */
export function cliMemoryLogger(deps: MemoryCliDeps): MemoryLogger {
  const write = (stage: string, message: string): void => deps.logErr(`[${stage}] ${message}`);
  return { warn: write, error: write, info: () => {}, debug: () => {} };
}

/**
 * The repository root and config one invocation acts on, resolved as `nax chat` resolves
 * them: the nearest `.nax` above `dir` names the root, and a directory with none is its own
 * root. `loadConfig` gets that `.nax` directory, or nothing when there is none.
 */
export async function memoryContext(dir: string, deps: MemoryCliDeps): Promise<MemoryCliContext> {
  const naxDir = deps.findProjectDir(dir);
  const config = await deps.loadConfig(naxDir ?? undefined);
  return { config, repoRoot: naxDir === null ? dir : dirname(naxDir) };
}

/**
 * The memory host for one invocation, or `null` when `memory.enabled` is false.
 *
 * The source is `human`: a note saved from the terminal was written by a person, and the
 * origin is what a later session reads before trusting the note.
 */
export function openMemoryHost(context: MemoryCliContext, deps: MemoryCliDeps): Promise<MemoryHost | null> {
  return deps.createMemoryHost({
    config: context.config,
    repoRoot: context.repoRoot,
    source: MEMORY_CLI_SOURCE,
    logger: cliMemoryLogger(deps),
  });
}

/** The refusal every subcommand but `status` answers with when the mirror is off. */
export function memoryDisabledError(): NaxError {
  return new NaxError("memory is disabled (memory.enabled is false)", "MEMORY_DISABLED", { stage: "memory" });
}

/** A bad flag value: the operator typed something the store's vocabulary does not hold. */
function memoryUsageError(message: string, data: Record<string, unknown> = {}): NaxError {
  return new NaxError(`[memory] ${message}`, "MEMORY_CLI_USAGE", { stage: "memory", ...data });
}

/**
 * Run one subcommand's body under the group's error contract: every throw becomes the one
 * `Error: <message>` line on stderr and exit code 1, so no handler repeats the shape.
 */
export async function withMemoryErrors(run: () => Promise<number>, deps: MemoryCliDeps): Promise<number> {
  try {
    return await run();
  } catch (error) {
    deps.logErr(`Error: ${errorMessage(error)}`);
    return 1;
  }
}

/**
 * One flag value checked against the vocabulary it must belong to.
 *
 * A value outside it is a usage error naming what arrived, raised before any file is read.
 * An absent or blank flag means "no filter" rather than "the empty value".
 */
function oneOf<T extends string>(given: string | undefined, allowed: readonly T[], flag: string): T | undefined {
  const raw = given?.trim();
  if (raw === undefined || raw === "") return undefined;
  const found = allowed.find((candidate) => candidate === raw);
  if (found === undefined) {
    throw memoryUsageError(`unknown ${flag} "${raw}"; expected one of ${allowed.join(", ")}`, { value: raw });
  }
  return found;
}

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
  return withMemoryErrors(async () => {
    const host = await openMemoryHost(await memoryContext(opts.dir, deps), deps);
    if (host === null) {
      deps.log(opts.json === true ? JSON.stringify({ enabled: false }) : "enabled: false");
      return 0;
    }
    const status = await host.status();
    deps.log(opts.json === true ? JSON.stringify(status) : formatMemoryStatus(status));
    return 0;
  }, deps);
}

/**
 * `nax memory list`: one row per note, project notes first then the machine's, each by slug.
 *
 * The flags are checked before the host is opened, so a typo in `--type` costs no read. Under
 * `--json` the rows are the document — each entry carries the note's fields but not its body,
 * which a listing never prints and no consumer of the list needs.
 */
export async function memoryListCommand(
  opts: MemoryListOptions,
  deps: MemoryCliDeps = _memoryCliDeps,
): Promise<number> {
  return withMemoryErrors(async () => {
    const type = oneOf(opts.type, NOTE_TYPES, "--type");
    const scope = oneOf(opts.scope, NOTE_SCOPES, "--scope");
    const host = await openMemoryHost(await memoryContext(opts.dir, deps), deps);
    if (host === null) throw memoryDisabledError();
    const notes = ofType(await readListing(host, scope), type);
    if (opts.json === true) {
      deps.log(JSON.stringify({ notes: notes.map(listingEntry) }));
    } else {
      for (const note of notes) deps.log(formatMemoryNoteLine(note));
    }
    return 0;
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
    .option("-d, --dir <path>", "Project directory", process.cwd())
    .option("--json", "Emit one machine-readable document", false)
    .action(async (opts: MemoryCliOptions) => {
      deps.exit(await memoryStatusCommand(opts, deps));
    });
  memory
    .command("list")
    .description("List saved memory notes, project notes first then user notes")
    .option("--type <type>", `Only notes of one type: ${NOTE_TYPES.join(", ")}`)
    .option("--scope <scope>", `Only notes in one scope: ${NOTE_SCOPES.join(", ")}`)
    .option("-d, --dir <path>", "Project directory", process.cwd())
    .option("--json", "Emit one machine-readable document", false)
    .action(async (opts: MemoryListOptions) => {
      deps.exit(await memoryListCommand(opts, deps));
    });
  return memory;
}
