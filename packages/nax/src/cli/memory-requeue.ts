/**
 * `nax memory requeue <slug> | --all` — put rejected outbox entries back in the queue.
 *
 * An entry is `rejected` when the provider refused it, or when a sync parked it after the
 * provider kept answering it badly (#2793). Neither is ever retried on its own, and a relink or
 * a reset refuses while one is held, so this is the way out: the entry is restored as it was
 * taken and the next `nax memory sync` decides it afresh. Exactly one of a slug or `--all` must
 * be given; both checks run before the host is opened.
 */
import type { MemoryScope } from "@nathapp/nax-agent";
import type { Command } from "commander";
import { NaxError } from "@/errors";
import type { MemoryRequeueTarget } from "@/memory";
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

const DEFAULT_REQUEUE_SCOPE: MemoryScope = "project";

/** What `requeue` takes on top of the group's flags. */
export interface MemoryRequeueOptions extends MemoryCliOptions {
  readonly scope?: string;
  readonly all?: boolean;
}

function requeueUsageError(message: string): NaxError {
  return new NaxError(`[memory] ${message}`, "MEMORY_CLI_USAGE", { stage: "memory" });
}

/** The entries the flags name: one note's, or every rejected one — never both, never neither. */
function requeueTargetOf(slug: string | undefined, opts: MemoryRequeueOptions): MemoryRequeueTarget {
  const all = opts.all === true;
  if (slug === undefined && !all) throw requeueUsageError("requeue needs a slug or --all");
  if (slug !== undefined && all) throw requeueUsageError("requeue takes a slug or --all, not both");
  if (slug === undefined) return "all";
  return { scope: parseNoteScope(opts.scope) ?? DEFAULT_REQUEUE_SCOPE, slug };
}

/** The line a requeue prints: how many writes went back, and what delivers them. */
function formatRequeueLine(count: number): string {
  if (count === 0) return "no rejected writes to requeue";
  return count === 1
    ? "requeued 1 rejected write; run nax memory sync to deliver it"
    : `requeued ${count} rejected writes; run nax memory sync to deliver them`;
}

/** `nax memory requeue`: requeue the rejected writes the flags name and print how many. */
export async function memoryRequeueCommand(
  slug: string | undefined,
  opts: MemoryRequeueOptions,
  deps: MemoryCliDeps = _memoryCliDeps,
): Promise<number> {
  return withMemoryErrors(async () => {
    const target = requeueTargetOf(slug, opts);
    return withMemoryHost(await memoryContext(opts.dir, deps), deps, async (host) => {
      if (host === null || host.requeue === undefined) throw memoryDisabledError();
      const count = await host.requeue(target);
      deps.log(opts.json === true ? JSON.stringify({ requeued: count }) : formatRequeueLine(count));
      return 0;
    });
  }, deps);
}

/** Register `requeue` on the `memory` group, through the group's deps seam. */
export function registerMemoryRequeueCommand(memory: Command, deps: MemoryCliDeps = _memoryCliDeps): Command {
  memory
    .command("requeue")
    .description("Put rejected memory writes back in the queue for the next sync")
    .argument("[slug]", "The note whose rejected writes to requeue")
    .option("--all", "Requeue every rejected write", false)
    .option("--scope <scope>", `The scope the note is in: ${NOTE_SCOPES.join(", ")}`, DEFAULT_REQUEUE_SCOPE)
    .option("-d, --dir <path>", "Project directory", memoryDefaultDir())
    .option("--json", "Emit one machine-readable document", false)
    .action(async (slug: string | undefined, opts: MemoryRequeueOptions) => {
      deps.exit(await memoryRequeueCommand(slug, opts, deps));
    });
  return memory;
}
