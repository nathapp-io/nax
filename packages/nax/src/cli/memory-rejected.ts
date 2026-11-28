/**
 * `nax memory requeue` and `nax memory discard` — what an operator does with undelivered writes.
 *
 * An outbox entry is undelivered in two ways. `rejected` means the provider refused it, or a
 * sync parked it after the provider kept answering it badly (#2793). `uncertain` means it was
 * dispatched by a provider that may not repeat it and never answered, so it may already exist on
 * the server. Neither is ever retried on its own, and a relink or a reset refuses while one is
 * held, so these two commands are the way out:
 *
 * - `requeue` restores the write as it was taken; the next `nax memory sync` decides it afresh.
 *   For an `uncertain` entry that means sending it again, which is why it takes
 *   `--allow-duplicate`: the operator is the only one who can decide a second copy is acceptable.
 * - `discard` drops it for good. A discarded forget leaves its note active on the provider, so
 *   the next sync brings the note back; the line says so.
 *
 * Each takes exactly one of a slug (with `--scope`), an entry's client id (`--client`, the handle
 * a "delivery unknown" answer prints) or `--all`. Every check runs before the host is opened.
 */
import type { MemoryScope } from "@nathapp/nax-agent";
import type { Command } from "commander";
import { NaxError } from "@/errors";
import type { MemoryHost, MemoryRecoveryResult, MemoryRecoveryTarget } from "@/memory";
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

/** The two things an operator can do with an undelivered write. */
type RejectedOp = "requeue" | "discard";

/** What `requeue` and `discard` take on top of the group's flags. */
export interface MemoryRejectedOptions extends MemoryCliOptions {
  readonly scope?: string;
  readonly client?: string;
  readonly all?: boolean;
  /** Requeue an entry whose dispatch may already have committed, accepting the duplicate risk. */
  readonly allowDuplicate?: boolean;
}

function rejectedUsageError(message: string): NaxError {
  return new NaxError(`[memory] ${message}`, "MEMORY_CLI_USAGE", { stage: "memory" });
}

/** The entries the flags name: one note's, one entry's, or every one — never two, never none. */
function rejectedTargetOf(op: RejectedOp, slug: string | undefined, opts: MemoryRejectedOptions): MemoryRecoveryTarget {
  const client = opts.client;
  const all = opts.all === true;
  const named = [slug !== undefined, client !== undefined, all].filter(Boolean).length;
  if (named === 0) throw rejectedUsageError(`${op} needs a slug, --client <id> or --all`);
  if (named > 1) throw rejectedUsageError(`${op} takes one of a slug, --client <id> or --all`);
  if (all && opts.scope !== undefined)
    throw rejectedUsageError("--scope names one note's scope; --all takes every scope");
  if (client !== undefined) {
    if (opts.scope !== undefined) throw rejectedUsageError("--scope names a slug's scope; --client names one entry");
    return { clientId: client };
  }
  if (slug === undefined) return "all";
  return { scope: parseNoteScope(opts.scope) ?? DEFAULT_REJECTED_SCOPE, slug };
}

/**
 * One line per recovery: how many writes moved, and — for a requeue the operator has not
 * acknowledged — which uncertain entries were left behind and the flag that takes them.
 *
 * A held-back entry is not a failure: refusing to send a write that may already have committed
 * is the safe answer, and the client id is what the operator acts on next.
 */
function formatRejectedLine(op: RejectedOp, result: MemoryRecoveryResult): string {
  const lines: string[] = [];
  if (result.moved === 0) lines.push(`no undelivered writes to ${op}`);
  else if (op === "discard") {
    const count = result.moved === 1 ? "discarded 1 undelivered write" : `discarded ${result.moved} undelivered writes`;
    lines.push(`${count}; a discarded forget leaves its note on the provider, and the next sync brings it back`);
  } else {
    const count = result.moved === 1 ? "requeued 1 undelivered write" : `requeued ${result.moved} undelivered writes`;
    const deliver = result.moved === 1 ? "deliver it" : "deliver them";
    lines.push(`${count}; run nax memory sync to ${deliver}`);
  }
  if (result.heldBack.length > 0) lines.push(heldBackLine(result.heldBack));
  return lines.join("\n");
}

/** Why an uncertain entry stayed put, and the one flag that would send it anyway. */
function heldBackLine(heldBack: readonly string[]): string {
  const clients = heldBack.map((client) => `--client ${client}`).join(", ");
  const them =
    heldBack.length === 1 ? "it may already exist on the provider" : "they may already exist on the provider";
  return `${heldBack.length} uncertain write(s) left in place (${clients}): ${them}, so nothing resends it automatically; add --allow-duplicate to send ${heldBack.length === 1 ? "it" : "them"} again`;
}

/** The document `--json` prints: what moved, and what it left for the operator. */
function rejectedDocument(op: RejectedOp, result: MemoryRecoveryResult): string {
  const key = op === "requeue" ? "requeued" : "discarded";
  return JSON.stringify({ [key]: result.moved, heldBack: result.heldBack });
}

/** One requeue through the host's optional member; a host without it is a disabled mirror. */
async function requeueEntries(
  host: MemoryHost,
  target: MemoryRecoveryTarget,
  allowDuplicate: boolean,
): Promise<MemoryRecoveryResult> {
  if (host.requeue === undefined) throw memoryDisabledError();
  return await host.requeue(target, { allowDuplicate });
}

/** One discard through the host's optional member; a host without it is a disabled mirror. */
async function discardEntries(host: MemoryHost, target: MemoryRecoveryTarget): Promise<MemoryRecoveryResult> {
  if (host.discard === undefined) throw memoryDisabledError();
  return await host.discard(target);
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
      if (host === null) throw memoryDisabledError();
      const result =
        op === "requeue"
          ? await requeueEntries(host, target, opts.allowDuplicate === true)
          : await discardEntries(host, target);
      deps.log(opts.json === true ? rejectedDocument(op, result) : formatRejectedLine(op, result));
      return 0;
    });
  }, deps);
}

/** `nax memory requeue`: put the undelivered writes the flags name back in the queue. */
export async function memoryRequeueCommand(
  slug: string | undefined,
  opts: MemoryRejectedOptions,
  deps: MemoryCliDeps = _memoryCliDeps,
): Promise<number> {
  return memoryRejectedCommand("requeue", slug, opts, deps);
}

/** `nax memory discard`: drop the undelivered writes the flags name. */
export async function memoryDiscardCommand(
  slug: string | undefined,
  opts: MemoryRejectedOptions,
  deps: MemoryCliDeps = _memoryCliDeps,
): Promise<number> {
  return memoryRejectedCommand("discard", slug, opts, deps);
}

/** One subcommand's shared flags, on whichever of the two it is. */
function withRejectedFlags(command: Command, op: RejectedOp, allHelp: string): Command {
  const flagged = command
    .argument("[slug]", "The note whose undelivered writes to act on")
    .option("--client <id>", "The client id of one entry, as a save or sync reports it")
    .option("--all", allHelp, false)
    .option(
      "--scope <scope>",
      `The scope the note is in: ${NOTE_SCOPES.join(", ")} (default ${DEFAULT_REJECTED_SCOPE})`,
    )
    .option("-d, --dir <path>", "Project directory", memoryDefaultDir())
    .option("--json", "Emit one machine-readable document", false);
  if (op !== "requeue") return flagged;
  // An uncertain entry may already exist on the provider, so sending it again is a decision.
  return flagged.option(
    "--allow-duplicate",
    "Send an uncertain write again even though the provider may already hold it",
    false,
  );
}

/** Register `requeue` and `discard` on the `memory` group, through the group's deps seam. */
export function registerMemoryRejectedCommands(memory: Command, deps: MemoryCliDeps = _memoryCliDeps): Command {
  withRejectedFlags(
    memory.command("requeue").description("Put undelivered memory writes back in the queue for the next sync"),
    "requeue",
    "Requeue every undelivered write",
  ).action(async (slug: string | undefined, opts: MemoryRejectedOptions) => {
    deps.exit(await memoryRequeueCommand(slug, opts, deps));
  });
  withRejectedFlags(
    memory.command("discard").description("Drop undelivered memory writes for good"),
    "discard",
    "Discard every undelivered write",
  ).action(async (slug: string | undefined, opts: MemoryRejectedOptions) => {
    deps.exit(await memoryDiscardCommand(slug, opts, deps));
  });
  return memory;
}
