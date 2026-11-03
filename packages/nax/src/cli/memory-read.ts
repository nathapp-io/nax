/**
 * `nax memory show` and `nax memory sync` — one note, and one sync (spec US-017).
 *
 * `show` is the terminal's answer to "what did an earlier session save?": the note exactly
 * as the store encodes it, or the same note as one JSON document under `--json`. `sync` runs
 * the mirror's one synchronisation and prints what it did.
 *
 * Both go through the group's shared plumbing (`memory-cli-deps.ts`): the same `--dir` and
 * `--json` flags, the same repository-root resolution, the same host and the same error
 * contract, so a failure reads the same on either subcommand.
 *
 * The exit status of `sync` is the result, not an exception: `synced`, `unreachable` and
 * `locked` are outcomes the mirror reports rather than errors it raises, and all three exit
 * 0 — an unreachable provider is a normal state for a mirror that queues its writes. Only
 * `failed` exits 1, and it still prints the line naming the failure: the operator asked what
 * happened, and a silent non-zero exit would answer less.
 */
import { type MemoryScope, serializeMemoryNote } from "@nathapp/nax-agent";
import type { Command } from "commander";
import { formatMemorySyncResult } from "@/memory";
import {
  _memoryCliDeps,
  type MemoryCliDeps,
  type MemoryCliOptions,
  memoryContext,
  memoryDefaultDir,
  memoryDisabledError,
  memoryNoteAbsentError,
  NOTE_SCOPES,
  parseNoteScope,
  withMemoryErrors,
  withMemoryHost,
} from "./memory-cli-deps";

/** The scope `show` reads when `--scope` is not given: the project's own note. */
const DEFAULT_NOTE_SCOPE: MemoryScope = "project";

/** What `show` takes on top of the group's flags: the scope to read the slug in. */
export interface MemoryShowOptions extends MemoryCliOptions {
  readonly scope?: string;
}

/**
 * `nax memory show <slug>`: the note, or `Error: no memory note <scope>/<slug>` and exit 1.
 *
 * The scope is checked before the host is opened, so a typo in `--scope` costs no read. The
 * text form is the store's own encoding — `serializeMemoryNote` — so what the terminal shows
 * is the file a session would have read, frontmatter included.
 */
export async function memoryShowCommand(
  slug: string,
  opts: MemoryShowOptions,
  deps: MemoryCliDeps = _memoryCliDeps,
): Promise<number> {
  return withMemoryErrors(async () => {
    const scope = parseNoteScope(opts.scope) ?? DEFAULT_NOTE_SCOPE;
    return withMemoryHost(await memoryContext(opts.dir, deps), deps, async (host) => {
      if (host === null) throw memoryDisabledError();
      const note = await host.getNote(scope, slug);
      if (note === null) throw memoryNoteAbsentError(scope, slug);
      deps.log(opts.json === true ? JSON.stringify(note) : serializeMemoryNote(note));
      return 0;
    });
  }, deps);
}

/**
 * `nax memory sync`: what the one run did, as a line or as the result document.
 *
 * The outcome is the exit status: `failed` is 1 and everything else is 0. The line is
 * printed either way — `formatMemorySyncResult` names the failure, which is the whole point
 * of the run having been asked for.
 */
export async function memorySyncCommand(opts: MemoryCliOptions, deps: MemoryCliDeps = _memoryCliDeps): Promise<number> {
  return withMemoryErrors(async () => {
    return withMemoryHost(await memoryContext(opts.dir, deps), deps, async (host) => {
      if (host === null) throw memoryDisabledError();
      const result = await host.sync();
      deps.log(opts.json === true ? JSON.stringify(result) : formatMemorySyncResult(result));
      return result.outcome === "failed" ? 1 : 0;
    });
  }, deps);
}

/**
 * Register `show` and `sync` on the `memory` group.
 *
 * The group itself is registered by `memory.ts`; this file adds the two subcommands that
 * read, and takes the group's deps seam so a stubbed `exit` or `createMemoryHost` reaches
 * them unchanged.
 */
export function registerMemoryReadCommands(memory: Command, deps: MemoryCliDeps = _memoryCliDeps): Command {
  memory
    .command("show")
    .description("Print one memory note")
    .argument("<slug>", "The note's slug")
    .option("--scope <scope>", `The scope to read: ${NOTE_SCOPES.join(", ")}`, DEFAULT_NOTE_SCOPE)
    .option("-d, --dir <path>", "Project directory", memoryDefaultDir())
    .option("--json", "Emit one machine-readable document", false)
    .action(async (slug: string, opts: MemoryShowOptions) => {
      deps.exit(await memoryShowCommand(slug, opts, deps));
    });
  memory
    .command("sync")
    .description("Synchronise the memory mirror with its provider")
    .option("-d, --dir <path>", "Project directory", memoryDefaultDir())
    .option("--json", "Emit one machine-readable document", false)
    .action(async (opts: MemoryCliOptions) => {
      deps.exit(await memorySyncCommand(opts, deps));
    });
  return memory;
}
