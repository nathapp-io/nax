/**
 * `nax memory compact` and `nax memory undo` — the terminal's two compaction commands (US-015,
 * US-016).
 *
 * The work of a compaction is `compactProjectMemory`'s (US-014): it reads the mirror, asks the
 * model, checks the plan and applies it. What is left to this file is the surface — the two
 * questions a terminal alone can answer, and the lines a person reads:
 *
 * - **May this run ask at all?** No TTY and no `--yes` is an abort *before* the mirror is opened,
 *   so a pipe or a CI job costs no model call. `--dry-run` is exempt: a preview writes nothing, so
 *   it needs no one to confirm it.
 * - **Does the person want the plan applied?** The plan is printed the moment the orchestration
 *   offers it — before the question, because the question is about the plan — and a `--yes` run has
 *   already answered, so it is never asked.
 *
 * The exit code is the outcome's: `applied`, `dry-run` and `nothing-to-compact` are successes;
 * every refusal is 1. A throw (`MEMORY_BUSY`, `MEMORY_COMPACT_FAILED`, a disabled mirror) is the
 * group's own contract, `withMemoryErrors` — `Error: <message>` on stderr and 1.
 *
 * `--json` moves the plan to stderr and makes stdout the one document, asking the question on
 * stderr too — the prompt's own text is routed there rather than merely echoed there — so
 * `nax memory compact --json | jq` reads a document and a person still sees what is being asked.
 * The document is the outcome itself: `outcome` is its kind, and the rest are the fields that kind
 * carries.
 *
 * `undo` is the way back, and the simplest surface here: it asks nothing, decides nothing, and
 * hands the id (or its absence, meaning the newest compaction not yet undone) and `--force`
 * straight to the host's `undoCompaction`. The safety is the archive's and the operation's — the
 * two refusals a person meets, a note that moved since (`MEMORY_COMPACT_CHANGED`) and a target
 * that is not there (`MEMORY_COMPACT_NOT_FOUND`), arrive already worded, so this file only puts
 * `Error: ` in front of them. Both commands take the same flags (`-d`, `--json`) and answer on the
 * same channels.
 */
import type { MemoryUndoResult } from "@nathapp/nax-agent/internal";
import type { Command } from "commander";
import { getProjectKey, memoryConfigOf } from "@/config";
import { NaxError } from "@/errors";
import { compactProjectMemory, type MemoryCompactOutcome, type MemoryCompactPreview } from "@/memory";
import { type ConfirmChannel, promptForConfirmation } from "./confirm";
import {
  _memoryCliDeps,
  type MemoryCliDeps,
  type MemoryCliOptions,
  memoryContext,
  memoryDefaultDir,
  memoryDisabledError,
  withMemoryErrors,
  withMemoryHost,
} from "./memory-cli-deps";

/** What a run nothing may be written by says, and the code it becomes. */
const ABORTED = "Aborted";
const ABORTED_CODE = 1;

/** The codes an outcome becomes: a refusal is never a success. */
const REFUSED_CODE = 1;
const OK_CODE = 0;

/** The one question this command asks. */
const APPLY_QUESTION = "Apply? [y/N]";

/** The three fixed refusals, each naming the mirror as it was left: unchanged. */
const UNPARSEABLE_LINE = "Error: the compaction model returned no usable plan; nothing was changed";
const INVALID_LINE = "Error: the compaction plan was rejected; nothing was changed";
const UNSUPPORTED_LINE =
  'Error: memory compaction is not available with memory.writeMode "proposal"; nothing was changed';

/** What `compact` takes on top of the group's flags: the two ways to run it unattended. */
export interface MemoryCompactOptions extends MemoryCliOptions {
  /** Apply the plan without asking. */
  readonly yes?: boolean;
  /** Preview the plan and write nothing. */
  readonly dryRun?: boolean;
}

/**
 * The seam this subcommand adds to the group's: the terminal it decides on, the answer it asks
 * for, and the orchestration it hands the mirror to.
 */
export interface MemoryCompactCliDeps extends MemoryCliDeps {
  isTTY(): boolean;
  /**
   * Ask the one question. `channel` is where the prompt's own text goes: `stderr` under
   * `--json`, whose stdout belongs to the document alone.
   */
  confirm(question: string, channel?: ConfirmChannel): Promise<boolean>;
  compactProjectMemory: typeof compactProjectMemory;
}

/** The real terminal, the real prompt, and the real orchestration. */
export const _memoryCompactCliDeps: Omit<MemoryCompactCliDeps, keyof MemoryCliDeps> = {
  isTTY: () => process.stdin.isTTY === true,
  confirm: promptForConfirmation,
  compactProjectMemory,
};

/** What a directly-called command runs with: the group's real deps under the compacting ones. */
const COMPACT_DEPS: MemoryCompactCliDeps = { ..._memoryCliDeps, ..._memoryCompactCliDeps };

/** The index as the whole percent every line of this command speaks in. */
function percent(fill: number): number {
  return Math.round(fill * 100);
}

/** Why a compaction stopped short of the target: everything left is not a candidate. */
function stillAtLine(fill: number): string {
  return `Still at ${percent(fill)}%: the remaining entries are not compaction candidates`;
}

/** The plan as a person reads it: a header, one line per change, and the note count either side. */
function planLines(project: string, preview: MemoryCompactPreview): readonly string[] {
  const retires = preview.plan.retire.map((retire) => `  retire ${retire.slug} - ${retire.reason}`);
  const merges = preview.plan.merge.map((merge) => `  merge ${merge.from.join(", ")} -> ${merge.into.slug}`);
  return [
    `Compaction plan for ${project} (${percent(preview.fillBefore)}% full, ${preview.notesBefore} notes):`,
    ...retires,
    ...merges,
    `Notes: ${preview.notesBefore} -> ${preview.notesAfter}`,
  ];
}

/**
 * What an applied compaction reports: what it changed, the fill it left, and where the undo lives.
 *
 * The merge count is notes, not merges: `merged 5 into 2` says five notes became two, which is
 * what a person is checking the plan against. A fill still at the threshold is named on a second
 * line, so "it worked" never reads as "memory is fine now".
 */
function appliedLines(
  outcome: Extract<MemoryCompactOutcome, { kind: "applied" }>,
  threshold: number,
): readonly string[] {
  const mergedNotes = outcome.result.merged.reduce((total, merge) => total + merge.from.length, 0);
  const counts = `(${percent(outcome.preview.fillBefore)}% -> ${percent(outcome.fillAfter)}%)`;
  const line =
    `Compacted memory: retired ${outcome.result.retired.length}, ` +
    `merged ${mergedNotes} into ${outcome.result.merged.length} ${counts}. ` +
    `Undo: nax memory undo ${outcome.result.id}`;
  return outcome.fillAfter >= threshold ? [line, stillAtLine(outcome.fillAfter)] : [line];
}

/** What one invocation is: its flags, its seam, and the two facts its lines are written from. */
interface CompactSurface {
  readonly opts: MemoryCompactOptions;
  readonly deps: MemoryCompactCliDeps;
  readonly project: string;
  readonly threshold: number;
  /** True when stdout belongs to the JSON document alone. */
  readonly json: boolean;
}

/** One outcome as text: the lines it writes, the channel they belong on, and the code it becomes. */
interface OutcomeReport {
  readonly lines: readonly string[];
  readonly toStderr: boolean;
  readonly code: number;
}

function aborted(): OutcomeReport {
  return { lines: [ABORTED], toStderr: true, code: ABORTED_CODE };
}

function refused(lines: readonly string[]): OutcomeReport {
  return { lines, toStderr: true, code: REFUSED_CODE };
}

/**
 * What one outcome says, spelled for a terminal.
 *
 * The dry run prints its plan here rather than in the confirmation: a preview asks nobody, so
 * nothing printed the plan on its way to the outcome.
 */
function textReport(outcome: MemoryCompactOutcome, surface: CompactSurface): OutcomeReport {
  switch (outcome.kind) {
    case "applied":
      return { lines: appliedLines(outcome, surface.threshold), toStderr: false, code: OK_CODE };
    case "dry-run":
      return { lines: planLines(surface.project, outcome.preview), toStderr: false, code: OK_CODE };
    case "nothing-to-compact":
      return { lines: [`Nothing to compact (${percent(outcome.fill)}% full)`], toStderr: false, code: OK_CODE };
    case "declined":
      return aborted();
    case "unparseable":
      return refused([UNPARSEABLE_LINE]);
    case "invalid":
      return refused([INVALID_LINE, ...outcome.reasons.map((reason) => `  - ${reason}`)]);
    case "unsupported":
      return refused([UNSUPPORTED_LINE]);
  }
}

/** The exit code an outcome becomes when it is answered as a document rather than as text. */
function exitCodeOf(outcome: MemoryCompactOutcome): number {
  const succeeded = outcome.kind === "applied" || outcome.kind === "dry-run" || outcome.kind === "nothing-to-compact";
  return succeeded ? OK_CODE : REFUSED_CODE;
}

/** The one document a `--json` run writes: the outcome's kind under `outcome`, then its fields. */
function documentOf(outcome: MemoryCompactOutcome): string {
  const { kind, ...fields } = outcome;
  return JSON.stringify({ outcome: kind, ...fields });
}

/** Write one outcome: the document under `--json`, its text lines otherwise. */
function reportOutcome(outcome: MemoryCompactOutcome, surface: CompactSurface): number {
  if (surface.json) {
    surface.deps.log(documentOf(outcome));
    return exitCodeOf(outcome);
  }
  const report = textReport(outcome, surface);
  const write = report.toStderr ? surface.deps.logErr : surface.deps.log;
  for (const line of report.lines) write(line);
  return report.code;
}

/** Show the plan on the channel the flags leave it, before anyone is asked about it. */
function printPlan(surface: CompactSurface, preview: MemoryCompactPreview): void {
  const write = surface.json ? surface.deps.logErr : surface.deps.log;
  for (const line of planLines(surface.project, preview)) write(line);
}

/**
 * The question, and the answer to it.
 *
 * A `--yes` run has already answered, so it asks no one. Everything else asks through the seam,
 * naming the channel the prompt's own text belongs on: `stderr` under `--json`, because stdout
 * there holds the document and a prompt printed into it would corrupt it. The prompt writes the
 * question itself, so the command adds no second copy of it.
 */
async function confirmApply(surface: CompactSurface): Promise<boolean> {
  if (surface.opts.yes === true) return true;
  return surface.deps.confirm(APPLY_QUESTION, surface.json ? "stderr" : "stdout");
}

/** The answer handed to the orchestration: the plan first, because the question is about it. */
async function confirmWith(surface: CompactSurface, preview: MemoryCompactPreview): Promise<boolean> {
  printPlan(surface, preview);
  return confirmApply(surface);
}

/**
 * `nax memory compact`: preview a compaction, ask once, and report what it did.
 *
 * The TTY check runs before the config is loaded or the mirror opened, so the abort costs nothing
 * but the answer. `--dry-run` and `--yes` both skip the question, and a dry run also skips the
 * apply — the orchestration never asks for confirmation on a preview, which is why a dry run needs
 * no terminal.
 *
 * @param opts - The group's flags, plus `--yes` and `--dry-run`
 * @param deps - The seam every external call goes through
 */
export async function memoryCompactCommand(
  opts: MemoryCompactOptions,
  deps: MemoryCompactCliDeps = COMPACT_DEPS,
): Promise<number> {
  return withMemoryErrors(async () => {
    if (opts.dryRun !== true && opts.yes !== true && !deps.isTTY()) {
      deps.logErr(ABORTED);
      return ABORTED_CODE;
    }
    const context = await memoryContext(opts.dir, deps);
    const surface: CompactSurface = {
      opts,
      deps,
      project: getProjectKey(context.config, context.repoRoot),
      threshold: memoryConfigOf(context.config).compact.threshold,
      json: opts.json === true,
    };
    return withMemoryHost(context, deps, async (host) => {
      if (host === null) throw memoryDisabledError();
      const outcome = await deps.compactProjectMemory({
        config: context.config,
        repoRoot: context.repoRoot,
        host,
        dryRun: opts.dryRun === true,
        confirm: async (preview) => confirmWith(surface, preview),
      });
      return reportOutcome(outcome, surface);
    });
  }, deps);
}

/**
 * What `undo` takes on top of the group's flags: permission to overwrite notes that moved on.
 */
export interface MemoryUndoOptions extends MemoryCliOptions {
  /** Undo even when a note changed since the compaction ran. */
  readonly force?: boolean;
}

/**
 * The one request `undoCompaction` takes: the compaction it names (absent for the newest one not
 * yet undone) and whether it may overwrite edits made since.
 */
interface UndoRequest {
  readonly id?: string;
  readonly force?: boolean;
}

/** What a host with no `undoCompaction` member answers, spelled once. */
const UNDO_UNSUPPORTED_MESSAGE = "memory undo is not available on this memory host";

/** The refusal a host that carries no compaction surface answers with, before anything is read. */
function undoUnsupportedError(): NaxError {
  return new NaxError(UNDO_UNSUPPORTED_MESSAGE, "MEMORY_COMPACT_UNSUPPORTED", { stage: "memory" });
}

/**
 * The request the two flags name.
 *
 * An unnamed id is left out of the object rather than sent as `undefined`, because that is what
 * the operation reads as "the newest compaction not yet undone" — one shape, one meaning.
 */
function undoRequestOf(id: string | undefined, opts: MemoryUndoOptions): UndoRequest {
  const force = opts.force === true;
  return id === undefined ? { force } : { id, force };
}

/**
 * The line an undo prints: which compaction came back, how many notes it restored, and how many
 * merged notes it removed.
 *
 * The counts are the result's own lengths, so the line and the `--json` document can never
 * disagree about what happened.
 */
function undoLine(result: MemoryUndoResult): string {
  return `Undid compaction ${result.id}: restored ${result.restored.length} notes, removed ${result.removed.length}`;
}

/**
 * `nax memory undo [<id>] [--force]`: restore what one compaction archived, and report what it
 * put back.
 *
 * There is nothing to decide and nothing to confirm here: the safety is the archive's, and the
 * two refusals an operator meets — a note that moved since (`MEMORY_COMPACT_CHANGED`, unless
 * `--force` says otherwise) and a target that is not there (`MEMORY_COMPACT_NOT_FOUND`) — are
 * raised by the operation the host calls. Each reaches the group's error contract unchanged, so
 * the operator reads the operation's own words after `Error: `. A `MemoryHost` that carries no
 * `undoCompaction` at all (only a hand-built one can) is refused the same way rather than
 * reported as an undo that did nothing.
 *
 * @param id - The compaction to undo, or `undefined` for the newest one not yet undone
 * @param opts - The group's flags, plus `--force`
 * @param deps - The seam every external call goes through
 */
export async function memoryUndoCommand(
  id: string | undefined,
  opts: MemoryUndoOptions,
  deps: MemoryCliDeps = _memoryCliDeps,
): Promise<number> {
  return withMemoryErrors(
    async () =>
      withMemoryHost(await memoryContext(opts.dir, deps), deps, async (host) => {
        if (host === null) throw memoryDisabledError();
        const undo = host.undoCompaction;
        if (undo === undefined) throw undoUnsupportedError();
        const result = await undo(undoRequestOf(id, opts));
        deps.log(opts.json === true ? JSON.stringify(result) : undoLine(result));
        return 0;
      }),
    deps,
  );
}

/**
 * Register `compact` and `undo` on the `memory` group, after the subcommands that read and write
 * notes — `compact` first, because `undo` restores what it archived.
 */
export function registerMemoryCompactCommands(memory: Command, deps: MemoryCompactCliDeps): Command {
  memory
    .command("compact")
    .description("Retire stale memory notes and merge overlapping ones, after showing the plan")
    .option("--yes", "Apply the plan without asking", false)
    .option("--dry-run", "Show the plan and write nothing", false)
    .option("-d, --dir <path>", "Project directory", memoryDefaultDir())
    .option("--json", "Emit one machine-readable document", false)
    .action(async (opts: MemoryCompactOptions) => {
      deps.exit(await memoryCompactCommand(opts, deps));
    });
  memory
    .command("undo")
    .description("Undo a compaction, restoring the notes it archived")
    .argument("[id]", "The compaction to undo (default: the newest one not yet undone)")
    .option("--force", "Undo even if notes changed since the compaction ran", false)
    .option("-d, --dir <path>", "Project directory", memoryDefaultDir())
    .option("--json", "Emit one machine-readable document", false)
    .action(async (id: string | undefined, opts: MemoryUndoOptions) => {
      deps.exit(await memoryUndoCommand(id, opts, deps));
    });
  return memory;
}
