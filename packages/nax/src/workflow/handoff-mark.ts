/**
 * The handed-off mark (chat-flow-handoff US-004): `workflow/<runId>/handoff.json`, a sidecar beside the
 * newest run's `result.json`. A chat chain that hands its feature to koda writes it so two local
 * publishers never race koda's own publish: `nax run --publish-only` and the chat `publish` launch both
 * refuse a marked feature, and the refusal names the file to delete.
 *
 * The mark is never uploaded — koda accepts only `result.json` and `ledger.md` — and it leaves
 * `result.json` and its mtime alone. Because it belongs to the newest run, a later `nax run` that writes
 * a newer `result.json` leaves the old mark behind on an older run, and the feature is publishable again.
 */
import { rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { runDirsNewestFirst } from "./result";

export const HANDOFF_MARK_FILE = "handoff.json";

export interface HandoffMark {
  readonly schemaVersion: 1;
  readonly at: string;
  /** Set when koda created the flow. */
  readonly flowId?: string;
  readonly url?: string;
  /** Set when koda held the create for approval. */
  readonly requestId?: string;
  /** Set when the branch was pushed but koda's answer never arrived (timeout, unreachable, cancelled during the create). */
  readonly outcomeUnknown?: true;
}

/** A mark found on the newest run, with the path a refusal tells the user to delete. */
export interface FoundHandoffMark {
  readonly mark: HandoffMark;
  readonly path: string;
}

/** What an unknown outcome reads as when the mark could not name a flow or an approval request. */
const UNKNOWN_OUTCOME = "outcome unknown; check koda's flows first";

/** A plain JSON object, not an array and not `null`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A parsed file that is a mark this module wrote: the schema version it understands, the time every
 * refusal names, and each optional field in the shape the refusal prints. A file koda or a person
 * edited into another shape is not a mark, so it refuses nothing.
 */
function isHandoffMark(value: unknown): value is HandoffMark {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.at !== "string") return false;
  const { flowId, url, requestId, outcomeUnknown } = value;
  if (!isAbsentOrString(flowId) || !isAbsentOrString(url) || !isAbsentOrString(requestId)) return false;
  return outcomeUnknown === undefined || outcomeUnknown === true;
}

/** A field a mark may carry, when it carries one. */
function isAbsentOrString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

/** The mark's own writes, stubbed in tests: nothing else in the run directory may be touched. */
export const _handoffMarkDeps = { rename, unlink };

/** Temporary siblings are named `<mark>.tmp-<uuid>`: unique per call, so two writers never share one. */
const TMP_INFIX = ".tmp-";

/** No two writes may share a temporary name: one rename would publish the file the other is writing. */
const tempSibling = (path: string): string => `${path}${TMP_INFIX}${crypto.randomUUID()}`;

/** Best-effort removal of this call's temporary file; the write's own error is the one to report. */
async function discard(path: string): Promise<void> {
  try {
    await _handoffMarkDeps.unlink(path);
  } catch {
    // already gone, or the rename published it
  }
}

/**
 * Writes the mark by completing a temporary sibling and renaming it over `handoff.json`, so a publish
 * check that reads while a handoff is marking the run sees either the previous complete mark or the new
 * one. A half-written file would read as "no mark" and let a local publish race koda. A failed write
 * removes its own sibling instead of leaving it in the run directory.
 */
export async function writeHandoffMark(runDir: string, mark: HandoffMark): Promise<void> {
  const path = join(runDir, HANDOFF_MARK_FILE);
  const tmp = tempSibling(path);
  try {
    await Bun.write(tmp, `${JSON.stringify(mark, null, 2)}\n`);
    await _handoffMarkDeps.rename(tmp, path);
  } catch (err) {
    await discard(tmp);
    throw err;
  }
}

/** The mark's parsed text, or null when the file is absent, unreadable or not a mark. */
async function readMark(path: string): Promise<HandoffMark | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    const parsed: unknown = JSON.parse(await file.text());
    return isHandoffMark(parsed) ? parsed : null;
  } catch {
    // A file that does not parse is not a mark, so it refuses nothing (the spec's Failure Handling row).
    return null;
  }
}

/**
 * The mark on the feature's newest run (by `result.json` mtime), or null when that run has none or it
 * does not parse. Only the newest run is read: a mark left on an older run stopped applying the moment a
 * later run wrote its own record, which is what lets a fresh `nax run` publish the feature again.
 */
export async function readNewestHandoffMark(featureWorkflowDir: string): Promise<FoundHandoffMark | null> {
  const [newest] = await runDirsNewestFirst(featureWorkflowDir);
  if (newest === undefined) return null;
  const path = join(newest, HANDOFF_MARK_FILE);
  const mark = await readMark(path);
  return mark === null ? null : { mark, path };
}

/**
 * How the refusal names what koda holds: the created flow with its URL, the approval request it held the
 * create for, or an unknown outcome — the push happened and koda's answer never arrived, so only koda's
 * own flows can say whether a publisher exists.
 */
function describedHandoff(mark: HandoffMark): string {
  if (mark.flowId !== undefined && mark.flowId !== "") {
    return mark.url === undefined || mark.url === "" ? `flow ${mark.flowId}` : `flow ${mark.flowId} ${mark.url}`;
  }
  if (mark.requestId !== undefined && mark.requestId !== "") return `approval request ${mark.requestId}`;
  return UNKNOWN_OUTCOME;
}

/** One sentence naming the flow or request and the mark's path, used by every refusal. */
export function handoffMarkRefusal(feature: string, found: FoundHandoffMark): string {
  const what = describedHandoff(found.mark);
  return `${feature} was handed off to koda (${what}) at ${found.mark.at}; koda publishes it. Delete ${found.path} to publish it here instead`;
}
