/**
 * The plumbing every `nax memory` subcommand shares: the seam its external calls go
 * through, the repository root and config one invocation acts on, the host it opens, the
 * flag vocabulary it validates against, and the one error contract it answers with.
 *
 * It lives here rather than in `memory.ts` for the reason `rules-cli-deps.ts` exists:
 * `memory.ts` registers the group, so it imports the files that register their own
 * subcommands (`memory-read.ts` and `memory-write.ts`). A sibling that imported this plumbing
 * back from the registrar would close a runtime import cycle, which `check:import-cycles`
 * rejects. `memory.ts` keeps what only `status` and `list` need.
 *
 * The command is a thin shell, as `nax cost` is: it resolves the repository root the way
 * `nax chat` resolves it (the nearest `.nax` above `--dir`, else `--dir`), hands the host
 * the config it loaded plus a logger for the terminal, and prints what the host answers.
 *
 * One error contract for every subcommand, present and future: anything thrown is
 * `Error: <message>` on stderr (also under `--json`) and exit 1. A disabled mirror is the
 * one failure `status` answers as data instead — `enabled: false`, exit 0 — because
 * "memory is off" is exactly what `status` exists to report.
 */
import { dirname } from "node:path";
import type { MemoryNoteType, MemoryScope } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { findProjectDir, loadConfig, type NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import { createMemoryHost, type MemoryHost, type MemoryLogger } from "@/memory";

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
export const NOTE_TYPES = ["user", "feedback", "project", "reference"] as const satisfies readonly MemoryNoteType[];
export const NOTE_SCOPES = ["project", "user"] as const satisfies readonly MemoryScope[];

/** What every `memory` subcommand takes: the directory it acts on, and the JSON switch. */
export interface MemoryCliOptions {
  readonly dir: string;
  readonly json?: boolean;
}

/** What a subcommand acts on: the config it loaded, and the repository it is rooted at. */
export interface MemoryCliContext {
  readonly config: NaxConfig;
  readonly repoRoot: string;
}

/**
 * The seam this group's every external call goes through: the repository walk, the config
 * load, the host, the file read `save --body-file` takes, plus the two output channels.
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
 * The `--dir` default: the group's one `process.cwd()` read, taken when a subcommand is
 * registered so the value is the directory the command was invoked from.
 */
export function memoryDefaultDir(): string {
  return process.cwd();
}

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

/** The `--type` a listing filters on, or `undefined` when the flag named none. */
export function parseNoteType(given: string | undefined): MemoryNoteType | undefined {
  return oneOf(given, NOTE_TYPES, "--type");
}

/** The `--scope` a read acts on, or `undefined` when the flag named none. */
export function parseNoteScope(given: string | undefined): MemoryScope | undefined {
  return oneOf(given, NOTE_SCOPES, "--scope");
}
