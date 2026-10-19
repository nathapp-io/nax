/**
 * Driving a loop-handler set the way the native loop drives it, plus the small
 * repository fixtures the rule-delivery tests seed.
 *
 * `LoopHandlerSet` is `readonly LoopHandlerEntry[]`, and an entry's handler is
 * typed for the whole `LoopEvent` union — so a test cannot call one with a
 * concrete payload any more than the dispatcher can. Production never does
 * either: `wrapExternalHandler` (`nax-agent`, `loop-events/external-handler.ts`)
 * re-narrows per event and maps a handler's `undefined` to "no patch", with a
 * `before_tool` `undefined` read as an allow (`settled`). `callBeforeTool`
 * applies exactly that rule, so an assertion is made against what the native
 * loop would have received rather than against a looser shape.
 *
 * The rule-repo fixtures are here for the same reason: the rule-delivery tests
 * (US-005) and the changed-file review tests (US-006) both need "a repo whose
 * rule `r` governs a file", and a second hand-rolled copy of that layout would
 * drift from the resolver it is meant to exercise.
 */

import { join } from "node:path";
import type {
  BeforeCompactionPayload,
  BeforeToolOutcome,
  BeforeToolPayload,
  LoopEvent,
  LoopHandlerContext,
  LoopHandlerEntry,
  LoopHandlerSet,
  PatchOf,
} from "@nathapp/nax-agent/internal";
import { assertDefined } from "./assert-defined";

// ─────────────────────────────────────────────────────────────────────────────
// Driving a handler set
// ─────────────────────────────────────────────────────────────────────────────

/** The registered entry for `event`, or a failed assertion naming it. */
export function loopHandlerEntry(set: LoopHandlerSet, event: LoopEvent): LoopHandlerEntry {
  const entry = set.find((candidate) => candidate.event === event);
  assertDefined(entry, `the ${event} entry in the delivered set`);
  return entry;
}

/** A tool call as a `before_tool` payload carries it (nax-ai's `ToolCall` shape). */
export function toolCall(name: string, input: Record<string, unknown>): BeforeToolPayload["call"] {
  return { id: `call-${name}`, name, input };
}

/** A `before_tool` payload for one call. No handler under test reads `tools`. */
export function beforeToolPayload(name: string, input: Record<string, unknown>): BeforeToolPayload {
  return { call: toolCall(name, input), tools: [] };
}

/**
 * The read-only facts a handler is handed. Absent keys stay absent — "no role"
 * is the absence of the key, which is exactly what a role-scoped handler reads.
 */
export function handlerContext(
  input: { sessionName?: string; role?: string; storyId?: string } = {},
): LoopHandlerContext {
  const { sessionName = "sess-rule-delivery", role, storyId = "US-005" } = input;
  return { sessionName, ...(role !== undefined ? { role } : {}), storyId };
}

/** A `before_compaction` payload; the rule-delivery handler reads none of it. */
export function beforeCompactionPayload(): BeforeCompactionPayload {
  return { reason: "proactive", toSummarize: [], estimatedTokens: 1_000 };
}

/** What a `before_tool` handler's answer holds as model-facing text. */
export function outcomeText(outcome: BeforeToolOutcome): string {
  if (outcome.kind === "nudge") return outcome.text;
  if (outcome.kind === "block" || outcome.kind === "terminate") return outcome.content;
  return "";
}

/** Run the set's `before_tool` handler as the native wrapper would. */
export async function callBeforeTool(
  set: LoopHandlerSet,
  payload: BeforeToolPayload,
  ctx: LoopHandlerContext,
): Promise<BeforeToolOutcome> {
  const entry = loopHandlerEntry(set, "before_tool");
  const answer = await entry.handler(payload, ctx);
  return answer === undefined ? { kind: "allow" } : settleBeforeTool(answer);
}

/** Run the set's `before_compaction` handler; its answer is returned untouched. */
export async function callBeforeCompaction(
  set: LoopHandlerSet,
  payload: BeforeCompactionPayload,
  ctx: LoopHandlerContext,
): Promise<PatchOf<LoopEvent> | undefined> {
  const entry = loopHandlerEntry(set, "before_compaction");
  return entry.handler(payload, ctx);
}

/** Only a `before_tool` patch carries a `kind`; anything else is no decision. */
function settleBeforeTool(answer: PatchOf<LoopEvent>): BeforeToolOutcome {
  return "kind" in answer ? answer : { kind: "allow" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule-repo fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** Write one rule file at `<root>/.nax/rules/<rel>`. */
export async function seedRule(root: string, rel: string, content: string): Promise<void> {
  await Bun.write(join(root, ".nax", "rules", rel), content);
}

/**
 * Give `<root>/<packageRel>` a package boundary marker, which is what
 * `findPackageDir` walks up to. Without it every path resolves to the repo root.
 */
export async function seedPackage(root: string, packageRel: string): Promise<void> {
  await Bun.write(join(root, packageRel, "package.json"), `{"name":"${packageRel}"}`);
}

/**
 * Write one rule file at `<root>/<packageRel>/.nax/rules/<rel>` — the package
 * layer `resolveRuleSet` lays over the repo layer. `seedRule` cannot express it:
 * its `<rel>` would have to climb back out of `.nax/rules/`.
 */
export async function seedPackageRule(root: string, packageRel: string, rel: string, content: string): Promise<void> {
  await Bun.write(join(root, packageRel, ".nax", "rules", rel), content);
}
