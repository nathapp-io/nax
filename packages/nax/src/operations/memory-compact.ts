/**
 * The memory compaction operation: one one-shot model call that answers with a plan.
 *
 * A compaction is planned, then checked, then applied — and only the first of those is a model
 * call. This module owns that call and the structural read of its reply; `validateMemoryCompactionPlan`
 * (`@nathapp/nax-agent/internal`) owns the semantic check against the mirror, and
 * `compactProjectMemory` (US-014) owns the apply. Keeping the two apart is what lets the
 * validator be the only place a plan is judged: the parser answers "is this the shape a plan
 * has?" and nothing more, so a well-formed plan naming a note that does not exist is `invalid`
 * (with reasons) rather than `unparseable`.
 *
 * Nothing here throws on a bad reply, and the op declares no retry: the model answers in prose
 * often enough that a thrown error would be the normal path, while the caller has an outcome
 * for `null` (F7: `unparseable`, nothing applied). A null-returning `parse` is this op's
 * exhaustion path — `callOp` hands the caller `null`, never a raw turn.
 */
import type { MemoryCompactionMerge, MemoryCompactionPlan, MemoryCompactionRetire } from "@nathapp/nax-agent/internal";
import { memoryCompactConfigSelector } from "@/config";
import type { MemoryCompactOpConfig } from "@/config/selectors";
import type { MemoryCompactInput } from "@/prompts";
import { buildMemoryCompactPrompt } from "@/prompts";
import { tryParseLLMJson } from "@/utils/llm-json";
import type { CompleteOperation } from "./types";

/**
 * The input is the prompt's, not this file's: the builder declares what a compaction is told,
 * and the op only forwards it. Re-exported so callers assembling a compaction import one name
 * from `@/operations` instead of reaching into `@/prompts` for the type and here for the op.
 */
export type { MemoryCompactInput };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every element a string; an absent array is `[]`, which is how the prompt says "leave it". */
function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** The two note types a merge target may carry — the plan's `into.type`, checked structurally. */
function isMergeType(value: unknown): value is MemoryCompactionMerge["into"]["type"] {
  return value === "project" || value === "reference";
}

/**
 * One `retire[]` entry, or `null` when its shape is wrong. The reason is required because it is
 * the justification the retire's forget is delivered with — a retire nobody can justify is not
 * a plan this feature accepts.
 */
function readRetire(entry: unknown): MemoryCompactionRetire | null {
  if (!isRecord(entry) || typeof entry.slug !== "string" || typeof entry.reason !== "string") return null;
  return { slug: entry.slug, reason: entry.reason };
}

/**
 * One `merge[].into`, or `null` when its shape is wrong. `type` is narrowed to the two note
 * types here rather than left as a string: it is the one field whose declared type is a literal
 * union, so a reply that says anything else is a malformed entry, not a plan for the validator
 * to judge.
 */
function readMergeInto(value: unknown): MemoryCompactionMerge["into"] | null {
  if (!isRecord(value) || !isMergeType(value.type)) return null;
  if (typeof value.slug !== "string" || typeof value.description !== "string") return null;
  if (typeof value.body !== "string") return null;
  return { slug: value.slug, type: value.type, description: value.description, body: value.body };
}

/** One `merge[]` entry, or `null` when its shape is wrong. */
function readMerge(entry: unknown): MemoryCompactionMerge | null {
  if (!isRecord(entry) || !isStringArray(entry.from)) return null;
  const into = readMergeInto(entry.into);
  if (into === null) return null;
  return { from: entry.from, into };
}

/** Read a list, treating an absent key as the empty list and a wrong-shaped one as malformed. */
function readList<T>(value: unknown, read: (entry: unknown) => T | null): readonly T[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const items: T[] = [];
  for (const entry of value) {
    const item = read(entry);
    if (item === null) return null;
    items.push(item);
  }
  return items;
}

/**
 * Read a model reply as a plan, or `null` when it is not one.
 *
 * Structural only: an absent `retire` or `merge` is `[]`, a present-but-malformed one makes the
 * whole reply `null`. Whether the named slugs exist, are candidates and share a type is
 * `validateMemoryCompactionPlan`'s question, asked under the mirror lock at apply time.
 */
export function parseMemoryCompactionPlan(output: string): MemoryCompactionPlan | null {
  const raw = tryParseLLMJson<unknown>(output);
  if (!isRecord(raw)) return null;
  const retire = readList(raw.retire, readRetire);
  const merge = readList(raw.merge, readMerge);
  if (retire === null || merge === null) return null;
  return { retire, merge };
}

/**
 * The one billed call a compaction makes. No tools and no session: the model is given facts
 * about this repository and the notes a session could lose, and it answers with a plan the
 * caller re-validates before anything is written.
 *
 * `stage: "plan"` is the permission stage, not the pipeline position — a compaction runs from
 * `nax memory compact` and from the chat offer, neither of which is a story.
 */
export const memoryCompactOp: CompleteOperation<
  MemoryCompactInput,
  MemoryCompactionPlan | null,
  MemoryCompactOpConfig
> = {
  kind: "complete",
  name: "memory-compact",
  stage: "plan",
  config: memoryCompactConfigSelector,
  model: (input) => input.model ?? "balanced",
  build: (input) => ({
    role: { id: "role", content: "", overridable: false },
    task: { id: "task", content: buildMemoryCompactPrompt(input), overridable: false },
  }),
  parse: (output) => parseMemoryCompactionPlan(output),
};
