/**
 * compact-project.ts — one compaction: the plan a model proposes, checked, and
 * applied only if a person says yes.
 *
 * The flow is one shared by `nax memory compact` and the chat offer, and it has
 * exactly one billed step. Everything around it is deterministic: the candidates
 * come from the mirror, the facts from the repository, the fill from the index,
 * and the plan is re-validated against the mirror before anything is written.
 *
 * ## What is read, and in which order
 *
 * A host that cannot compact, or that writes proposals, is refused before any
 * read: neither has an apply behind it, and a model call would buy a plan nothing
 * could carry out. A mirror with no candidates is refused next, and before the
 * facts are read — a plan with nothing to act on is not worth three git reads.
 * Both refusals answer the fill, so a surface can say how full memory is while
 * saying there is nothing to compact.
 *
 * ## Why the model runs outside any lock
 *
 * No lock covers the model call or the confirmation: a compaction is a person
 * reading a preview and answering, which can take as long as it takes, and
 * holding the mirror for it would stop every save in the project. The host
 * re-validates the plan against the mirror under its lock at apply time, so a
 * note that changed while the preview was up is reported as an invalid plan
 * rather than written over.
 *
 * ## The CallContext
 *
 * Built from the config this call was handed, with `createRuntime` — never by
 * re-loading the config. That is what makes a chat started with `--profile`
 * compact under the profile it was started with rather than under whatever the
 * disk says now, and it is the one thing this module shares with `nax setup`.
 * The runtime is closed on both exits, so a refused plan costs no idle watchdog.
 *
 * The preview projects a note count, not a fill: a plan's own effect on the index
 * depends on the bodies it writes, so a "fill after" shown before the apply would
 * be a guess. `notesAfter` is exact arithmetic over the plan, and `fillAfter` is
 * measured after the apply, from the mirror as it then stands.
 */
import type { MemoryNote } from "@nathapp/nax-agent";
import {
  type MemoryCompactionPlan,
  type MemoryCompactionResult,
  validateMemoryCompactionPlan,
} from "@nathapp/nax-agent/internal";
import { type ConfiguredModel, type MemoryConfig, memoryConfigOf, type NaxConfig } from "@/config";
import { type CallContext, callOp, type MemoryCompactInput, memoryCompactOp } from "@/operations";
import { createRuntime } from "@/runtime";
import { readMemoryCompactFacts } from "./compact-facts";
import { memoryIndexFill } from "./fill";
import type { MemoryHost } from "./host";

/**
 * One compaction as its surface shows it before anything is written.
 *
 * `notesBefore` and `notesAfter` are the project scope's note counts on either
 * side of the plan; `fillBefore` is the index's fill at the moment the plan was
 * proposed, which the host records in the archive.
 */
export interface MemoryCompactPreview {
  readonly plan: MemoryCompactionPlan;
  readonly fillBefore: number;
  readonly notesBefore: number;
  readonly notesAfter: number;
}

/**
 * What one `compactProjectMemory` call came to. Every arm but `applied` leaves
 * the mirror exactly as it was; `fill` is present on `nothing-to-compact` so a
 * surface can report memory's state alongside the refusal.
 */
export type MemoryCompactOutcome =
  | {
      readonly kind: "applied";
      readonly preview: MemoryCompactPreview;
      readonly result: MemoryCompactionResult;
      readonly fillAfter: number | null;
    }
  | { readonly kind: "declined"; readonly preview: MemoryCompactPreview }
  | { readonly kind: "dry-run"; readonly preview: MemoryCompactPreview }
  | { readonly kind: "nothing-to-compact"; readonly fill: number }
  | { readonly kind: "unparseable" }
  | { readonly kind: "invalid"; readonly reasons: readonly string[] }
  | { readonly kind: "unsupported" };

/** One compaction to run: the config, the repository, the mirror, and the person's answer. */
export interface CompactProjectMemoryInput {
  readonly config: NaxConfig;
  readonly repoRoot: string;
  readonly host: MemoryHost;
  /** Answer with the preview and write nothing — the shape `nax memory compact --dry-run` needs. */
  readonly dryRun: boolean;
  readonly confirm: (preview: MemoryCompactPreview) => Promise<boolean>;
}

/**
 * The op dispatch and the CallContext builder.
 *
 * `buildCallContext` builds the runtime from `input.config` with `createRuntime`
 * (never re-loading config), so a chat started with `--profile` compacts under
 * its own config.
 */
export const _compactProjectDeps: {
  callOp: typeof callOp;
  readFacts: typeof readMemoryCompactFacts;
  buildCallContext: (
    config: NaxConfig,
    repoRoot: string,
  ) => { readonly ctx: CallContext; readonly close: () => Promise<void> };
} = {
  callOp,
  readFacts: readMemoryCompactFacts,
  buildCallContext: (config, repoRoot) => {
    const runtime = createRuntime(config, repoRoot);
    return {
      ctx: {
        runtime,
        packageView: runtime.packages.resolve(),
        packageDir: repoRoot,
        agentName: runtime.agentManager.getDefault(),
      },
      close: () => runtime.close(),
    };
  },
};

/**
 * The configured compaction model as the string the archive records: a tier or a
 * model id as written, and the object form as `<agent>/<model>`.
 */
function modelString(model: ConfiguredModel): string {
  return typeof model === "string" ? model : `${model.agent}/${model.model}`;
}

/**
 * How many project notes the mirror holds once `plan` has run.
 *
 * A retire takes one note away, a merge writes one and retires its sources. A
 * merge whose target reuses one of its own source slugs is both: the note that
 * was there is retired and the merged note takes its place, so counting the whole
 * source list and then the merge once is right. Excluding that target because the
 * slug already exists would drop the note that replaced it.
 */
function notesAfterOf(plan: MemoryCompactionPlan, notesBefore: number, repository: ReadonlySet<string>): number {
  const unshadowed = [
    ...plan.retire.map((r) => r.slug),
    ...plan.merge.flatMap((m) => m.from.filter((s) => s !== m.into.slug)),
  ].filter((s) => repository.has(s)).length;
  const mergedAway = plan.merge.reduce((total, merge) => total + merge.from.length, 0);
  return notesBefore + unshadowed - plan.retire.length - mergedAway + plan.merge.length;
}

/** The index as a whole percent, which is the unit the prompt is written in. */
function percent(fill: number): number {
  return Math.round(fill * 100);
}

/** Everything the deterministic half of one compaction reads up front. */
interface CompactReads {
  readonly projectNotes: readonly MemoryNote[];
  readonly candidates: readonly MemoryNote[];
  readonly fillBefore: number;
}

/**
 * The mirror as the compaction finds it: the index the fill is measured from, the
 * project notes a merge target may not take the slug of, and the notes a plan may
 * act on. The three reads are independent, so they run together.
 */
async function readMirror(
  host: MemoryHost,
  candidates: NonNullable<MemoryHost["compactionCandidates"]>,
  indexBytes: number,
): Promise<CompactReads> {
  const [index, projectNotes, candidates_] = await Promise.all([
    host.renderIndex(),
    host.notes("project"),
    candidates(),
  ]);
  return { projectNotes, candidates: candidates_, fillBefore: memoryIndexFill(index, indexBytes) };
}

/** Run the one billed call, closing the runtime it needed on both exits. */
async function dispatchPlan(
  input: CompactProjectMemoryInput,
  planInput: MemoryCompactInput,
): Promise<MemoryCompactionPlan | null> {
  const { ctx, close } = _compactProjectDeps.buildCallContext(input.config, input.repoRoot);
  try {
    return await _compactProjectDeps.callOp(ctx, memoryCompactOp, planInput);
  } finally {
    await close();
  }
}

/** What the model stage came to: a plan worth previewing, or the outcome in its place. */
type PlannedCompaction =
  | { readonly kind: "planned"; readonly plan: MemoryCompactionPlan }
  | { readonly kind: "failed"; readonly outcome: MemoryCompactOutcome };

/**
 * The billed half: the facts, the prompt's input, the one call, and the check.
 *
 * The check is not a formality — it is the only thing between a model's reply and
 * a person's archive. It reads the same candidates the prompt listed and the
 * project notes whose slugs a merge target may not take (the mirror's own slugs
 * plus the repository's, since `host.notes("project")` merges them; the apply
 * re-checks the same question under its lock). Every reason it returns reaches
 * the surface, so one revision can answer all of them.
 */
async function planCompaction(
  input: CompactProjectMemoryInput,
  reads: CompactReads,
  memory: MemoryConfig,
): Promise<PlannedCompaction> {
  const facts = await _compactProjectDeps.readFacts(input.repoRoot);
  const planInput: MemoryCompactInput = {
    notes: reads.candidates,
    features: facts.features,
    branches: facts.branches,
    commits: facts.commits,
    fillPercent: percent(reads.fillBefore),
    targetPercent: percent(memory.compact.threshold),
    model: memory.compact.model,
  };
  const plan = await dispatchPlan(input, planInput);
  if (plan === null) return { kind: "failed", outcome: { kind: "unparseable" } };
  const existingSlugs = new Set(reads.projectNotes.map((note) => note.slug));
  const check = validateMemoryCompactionPlan(plan, reads.candidates, existingSlugs);
  if (!check.ok) return { kind: "failed", outcome: { kind: "invalid", reasons: check.reasons } };
  return { kind: "planned", plan };
}

/**
 * Compact this project's memory: one model call, one validation, one apply.
 *
 * @param input.config - The loaded config this call runs under (not re-loaded)
 * @param input.repoRoot - The repository the facts are read from
 * @param input.host - The mirror being compacted
 * @param input.dryRun - Answer with the preview and write nothing
 * @param input.confirm - Shown the preview; `false` leaves the mirror alone
 */
export async function compactProjectMemory(input: CompactProjectMemoryInput): Promise<MemoryCompactOutcome> {
  const { host } = input;
  const capabilities = host.compactionCandidates;
  if (capabilities === undefined || host.applyCompaction === undefined) return { kind: "unsupported" };
  if (host.writeMode === "proposal") return { kind: "unsupported" };

  const memory = memoryConfigOf(input.config);
  const reads = await readMirror(host, capabilities, memory.indexBytes);
  if (reads.candidates.length === 0) return { kind: "nothing-to-compact", fill: reads.fillBefore };

  const planned = await planCompaction(input, reads, memory);
  if (planned.kind === "failed") return planned.outcome;

  const preview: MemoryCompactPreview = {
    plan: planned.plan,
    fillBefore: reads.fillBefore,
    notesBefore: reads.projectNotes.length,
    notesAfter: notesAfterOf(planned.plan, reads.projectNotes.length, (await host.repositorySlugs?.()) ?? new Set()),
  };
  if (input.dryRun) return { kind: "dry-run", preview };
  if (!(await input.confirm(preview))) return { kind: "declined", preview };

  const result = await host.applyCompaction({
    plan: planned.plan,
    expectedCandidates: reads.candidates,
    model: modelString(memory.compact.model),
    fillBefore: reads.fillBefore,
  });
  let fillAfter: number | null = null;
  try {
    fillAfter = memoryIndexFill(await host.renderIndex(), memory.indexBytes);
  } catch {
    // The apply has committed; an unavailable measurement cannot invalidate the undo id.
  }
  return { kind: "applied", preview, result, fillAfter };
}
