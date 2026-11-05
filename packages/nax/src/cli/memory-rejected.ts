/**
 * `nax memory requeue` and `nax memory discard` — what an operator does with rejected writes.
 *
 * An outbox entry is `rejected` when the provider refused it, or when a sync parked it after
 * the provider kept answering it badly (#2793). Neither is ever retried on its own, and a
 * relink or a reset refuses while one is held, so these two are the way out:
 *
 * - `requeue` restores the write as it was taken; the next `nax memory sync` decides it afresh.
 * - `discard` drops it for good. A discarded forget leaves its note active on the provider, so
 *   the next sync brings the note back; the line says so.
 *
 * Each takes exactly one of a slug (with `--scope`) or `--all`; both checks run before the host
 * is opened.
 */
import type { MemoryScope } from "@nathapp/nax-agent";
import type { Command } from "commander";
import { NaxError } from "@/errors";
import type { MemoryRejectedTarget } from "@/memory";
import {
  _memoryCliDeps,
  type MemoryCliDeps,
  type MemoryCliOptions,
  memoryContext,
  memoryDefaultDir,
  memoryDisabledError,
  NOTE_SCOPES,
  parseNoteScope,
  withMemoryErrors,
  withMemoryHost,
} from "./memory-cli-deps";

const DEFAULT_REJECTED_SCOPE: MemoryScope = "project";

/** The two things an operator can do with a rejected write. */
type RejectedOp = "requeue" | "discard";

/** What `requeue` and `discard` take on top of the group's flags. */
export interface MemoryRejectedOptions extends MemoryCliOptions {
  readonly scope?: string;
  readonly all?: boolean;
}

function rejectedUsageError(message: string): NaxError {
  return new NaxError(`[memory] ${message}`, "MEMORY_CLI_USAGE", { stage: "memory" });
}

/** The entries the flags name: one note's, or every rejected one — never both, never neither. */
function rejectedTargetOf(op: RejectedOp, slug: string | undefined, opts: MemoryRejectedOptions): MemoryRejectedTarget {
  const all = opts.all === true;
  if (slug === undefined && !all) throw rejectedUsageError(`${op} needs a slug or --all`);
  if (slug !== undefined && all) throw rejectedUsageError(`${op} takes a slug or --all, not both`);
  if (all && opts.scope !== undefined)
    throw rejectedUsageError("--scope names one note's scope; --all takes every scope");
  if (slug === undefined) return "all";
  return { scope: parseNoteScope(opts.scope) ?? DEFAULT_REJECTED_SCOPE, slug };
}

/** `requeued N rejected write(s)` or `discarded …`: `1` is singular, any other count plural. */
function countedWrites(verb: string, count: number): string {
  return count === 1 ? `${verb} 1 rejected write` : `${verb} ${count} rejected writes`;
}

/** The line an operation prints: how many writes it moved, and what follows from it. */
function formatRejectedLine(op: RejectedOp, count: number): string {
  if (count === 0) return `no rejected writes to ${op}`;
  if (op === "discard") {
    const tail = "a discarded forget leaves its note on the provider, and the next sync brings it back";
    return `${countedWrites("discarded", count)}; ${tail}`;
  }
  const deliver = count === 1 ? "deliver it" : "deliver them";
  return `${countedWrites("requeued", count)}; run nax memory sync to ${deliver}`;
}

/** Run one operation: check the flags, open the host, act on the entries the flags name. */
async function memoryRejectedCommand(
  op: RejectedOp,
  slug: string | undefined,
  opts: MemoryRejectedOptions,
  deps: MemoryCliDeps,
): Promise<number> {
  return withMemoryErrors(async () => {
    const target = rejectedTargetOf(op, slug, opts);
    return withMemoryHost(await memoryContext(opts.dir, deps), deps, async (host) => {
      const run = host === null ? undefined : host[op];
      if (run === undefined) throw memoryDisabledError();
      const count = await run(target);
      const key = op === "requeue" ? "requeued" : "discarded";
      deps.log(opts.json === true ? JSON.stringify({ [key]: count }) : formatRejectedLine(op, count));
      return 0;
    });
  }, deps);
}

/** `nax memory requeue`: put the rejected writes the flags name back in the queue. */
export async function memoryRequeueCommand(
  slug: string | undefined,
  opts: MemoryRejectedOptions,
  deps: MemoryCliDeps = _memoryCliDeps,
): Promise<number> {
  return memoryRejectedCommand("requeue", slug, opts, deps);
}

/** `nax memory discard`: drop the rejected writes the flags name. */
export async function memoryDiscardCommand(
  slug: string | undefined,
  opts: MemoryRejectedOptions,
  deps: MemoryCliDeps = _memoryCliDeps,
): Promise<number> {
  return memoryRejectedCommand("discard", slug, opts, deps);
}

/** One subcommand's shared flags, on whichever of the two it is. */
function withRejectedFlags(command: Command, allHelp: string): Command {
  return command
    .argument("[slug]", "The note whose rejected writes to act on")
    .option("--all", allHelp, false)
    .option(
      "--scope <scope>",
      `The scope the note is in: ${NOTE_SCOPES.join(", ")} (default ${DEFAULT_REJECTED_SCOPE})`,
    )
    .option("-d, --dir <path>", "Project directory", memoryDefaultDir())
    .option("--json", "Emit one machine-readable document", false);
}

/** Register `requeue` and `discard` on the `memory` group, through the group's deps seam. */
export function registerMemoryRejectedCommands(memory: Command, deps: MemoryCliDeps = _memoryCliDeps): Command {
  withRejectedFlags(
    memory.command("requeue").description("Put rejected memory writes back in the queue for the next sync"),
    "Requeue every rejected write",
  ).action(async (slug: string | undefined, opts: MemoryRejectedOptions) => {
    deps.exit(await memoryRequeueCommand(slug, opts, deps));
  });
  withRejectedFlags(
    memory.command("discard").description("Drop rejected memory writes for good"),
    "Discard every rejected write",
  ).action(async (slug: string | undefined, opts: MemoryRejectedOptions) => {
    deps.exit(await memoryDiscardCommand(slug, opts, deps));
  });
  return memory;
}
