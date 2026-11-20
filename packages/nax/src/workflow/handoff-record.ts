/**
 * The run record a chat chain hands to koda (chat-flow-handoff US-002): `.nax/features/<feature>/workflow/`
 * is git-excluded and lives only on the machine that ran the chain, so a handoff uploads the newest runs'
 * `result.json` and `ledger.md` instead of pointing koda at them. What is sent is bounded by koda's own
 * shape limits (`packages/fleet-protocol/src/index.ts` in koda), so every refusal here repeats a rule
 * koda would apply to the same body.
 *
 * US-003 adds the two preflights koda applies after the shape limits: the newest run must be a finished
 * feature record that ended without a PR at the pushed HEAD, and the `prd.json` committed at that HEAD
 * must name the branch and hold no pending story. Both halves stop at the first failing check, so a
 * refusal names the one thing the user has to fix.
 *
 * The collector anchors its lookup at the trusted root and opens each component relative to the
 * preceding directory handle, without following links. It retains the listed run handles through
 * the file reads, so renaming a checked directory cannot retarget an upload. Files are read from
 * the same handles as their stats, in bounded chunks; the cap is the uploaded text's UTF-8 size.
 */
import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { featureDir } from "@/config";
import { type PRD, pendingStoryIds } from "@/prd";
import { gitWithTimeout } from "@/utils/git";
import { isFeatureRecord } from "./feature-record";
import { DIRECTORY_FLAGS, listHandoffChildren, openHandoffChild } from "./handoff-directory";
import { workflowFeatureDir } from "./paths";
import { isWorkflowResult } from "./result";

/** One file a handoff sends: the run it belongs to, its name, the mtime koda compares, and its text. */
export interface HandoffRecordFile {
  readonly runId: string;
  readonly file: "result.json" | "ledger.md";
  readonly mtimeMs: number;
  readonly content: string;
}

/** koda accepts at most this many distinct run ids (`HANDOFF_MAX_RUNS` in koda's fleet protocol). */
export const HANDOFF_MAX_RUNS = 20;

/** koda accepts at most this many UTF-8 bytes of `content`, summed over every entry. */
export const HANDOFF_RECORD_MAX_BYTES = 524288;

export type HandoffRecordRead =
  | { readonly ok: true; readonly record: readonly HandoffRecordFile[]; readonly newestRunId: string }
  | { readonly ok: false; readonly reason: string };

const RESULT_FILE = "result.json";
const LEDGER_FILE = "ledger.md";
/** The record files of one run, in the order the handoff sends them. */
const RECORD_FILES = [RESULT_FILE, LEDGER_FILE] as const;
const NO_FINISHED_RUN = "no finished workflow run for this feature; run nax run first";
const NEWEST_TIE = "two workflow runs share the newest result.json time, so the newest run is ambiguous";
/**
 * How much of a record file is held at a time. The cap bounds what is sent; this bounds what is read,
 * so a run record of any size is counted and refused without being loaded whole.
 */
const RECORD_CHUNK_BYTES = 65536;
/**
 * Read-only, never through a link, and never blocking: a record file is opened as a plain file or not
 * at all. `O_NONBLOCK` is what makes a FIFO answer the open instead of waiting for a writer — the
 * handle's own stat then refuses it like any other special file.
 */
const RECORD_FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** A verified regular file and the integer mtime we send to koda. */
interface OpenRecordFile {
  readonly handle: FileHandle;
  readonly mtimeMs: number;
}

/** A run and its result, both pinned from inspection through collection. */
interface RunDir {
  readonly runId: string;
  readonly directory: FileHandle;
  readonly result: OpenRecordFile;
}

async function closeRun(run: RunDir): Promise<void> {
  await Promise.all([run.result.handle.close(), run.directory.close()]);
}

/** One record file as its own verified handle reported it. */
type FileRead =
  | {
      readonly ok: true;
      /** The handle's mtime, truncated — the integer koda compares. */
      readonly mtimeMs: number;
      /**
       * The UTF-8 size of the decoded text, which is what koda's cap measures: a malformed byte
       * decodes to a three-byte replacement character and a BOM decodes to nothing, so the file's own
       * length is not the number the record is refused on. Counted past the cap too, so the refusal
       * still names the exact total.
       */
      readonly bytes: number;
      /** True while no chunk of the text held a NUL or an unpaired surrogate. */
      readonly storable: boolean;
      /** The text, kept only while the whole record may still fit koda's cap. */
      readonly text?: string;
    }
  /** The path holds nothing: the run does not send that entry. */
  | { readonly ok: false; readonly absent: true }
  /** The path holds a link or a special file, which no handoff may read. */
  | { readonly ok: false; readonly absent: false };

function refusal(reason: string): HandoffRecordRead {
  return { ok: false, reason };
}

/** The errno code of a thrown filesystem error, when it carries one. */
function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

/** A record file that is a link or a special file, which the handoff refuses to send. */
function notPlainFileReason(runId: string, file: HandoffRecordFile["file"]): string {
  return `${file} of run ${runId} is a link or a special file, not a regular file the handoff can read`;
}

/** A run that is not a real directory of this feature, so its files are not this feature's record. */
function linkedRunReason(runId: string): string {
  return `the workflow run ${runId} is a link, not a run directory of this feature; the handoff reads only the feature's own runs`;
}

/** A directory on the way to a run that is a link, so its files are not this feature's own record. */
function linkedDirReason(path: string): string {
  return `${path} is a link, not a directory of this feature; the handoff reads only the feature's own runs`;
}

function directoryRefusal(dirPath: string, error: unknown): string | undefined {
  const code = errnoCode(error);
  if (code === "ENOENT") return NO_FINISHED_RUN;
  if (code === "ELOOP" || code === "ENOTDIR") return linkedDirReason(dirPath);
  return undefined;
}

/** Walk one component at a time from the trusted root; hold the final directory through collection. */
async function collectBelow(
  directory: FileHandle,
  dirPath: string,
  parts: readonly string[],
): Promise<HandoffRecordRead> {
  const [name, ...rest] = parts;
  if (name === undefined) return await collectRuns(directory);
  const childPath = join(dirPath, name);
  let child: FileHandle;
  try {
    child = await openHandoffChild(directory, name, DIRECTORY_FLAGS);
  } catch (error) {
    const reason = directoryRefusal(childPath, error);
    if (reason !== undefined) return refusal(reason);
    throw error;
  }
  try {
    return await collectBelow(child, childPath, rest);
  } finally {
    await child.close();
  }
}

/** Keep the directory from the listing, not a name to resolve again when reading the record. */
async function inspectRun(directory: FileHandle, runId: string): Promise<RunDir | string | undefined> {
  let run: FileHandle;
  try {
    run = await openHandoffChild(directory, runId, DIRECTORY_FLAGS);
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT") return undefined;
    if (code === "ENOTDIR" || code === "ELOOP") return linkedRunReason(runId);
    throw error;
  }
  let keep = false;
  try {
    const result = await openPlainFile(run, RESULT_FILE);
    if ("ok" in result) return result.absent ? undefined : notPlainFileReason(runId, RESULT_FILE);
    keep = true;
    return { runId, directory: run, result };
  } finally {
    if (!keep) await run.close();
  }
}

type FileRefusal = Extract<FileRead, { ok: false }>;

/**
 * Pin a regular file and capture its mtime. No link is followed and the non-blocking open lets
 * the descriptor's own stat refuse a special file (such as a FIFO) without waiting for a writer.
 */
async function openPlainFile(directory: FileHandle, file: string): Promise<OpenRecordFile | FileRefusal> {
  let handle: FileHandle;
  try {
    handle = await openHandoffChild(directory, file, RECORD_FILE_FLAGS);
  } catch (err) {
    const code = errnoCode(err);
    if (code === "ENOENT") return { ok: false, absent: true };
    // ELOOP: the path became a link after the listing checked it. A link is never read through.
    if (code === "ELOOP") return { ok: false, absent: false };
    // ENXIO: a socket, which has no bytes of its own to read.
    if (code === "ENXIO") return { ok: false, absent: false };
    throw err;
  }
  let keep = false;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return { ok: false, absent: false };
    keep = true;
    return { handle, mtimeMs: Math.trunc(stats.mtimeMs) };
  } finally {
    if (!keep) await handle.close();
  }
}

/**
 * One open record file, read a chunk at a time: the UTF-8 size of the decoded text is counted, and at
 * most the remaining budget is kept. Each decoded chunk is checked for the text koda refuses;
 * `TextDecoder` with `stream: true` holds an incomplete character back, so a chunk never ends inside a
 * surrogate pair. The count is the size of the text koda would store, not of the file, because that is
 * what its cap measures: a malformed byte decodes to a three-byte replacement character, and a BOM is
 * dropped rather than sent.
 */
async function readChunks(handle: FileHandle, mtimeMs: number, budget: number): Promise<FileRead> {
  const decoder = new TextDecoder();
  const buffer = Buffer.alloc(RECORD_CHUNK_BYTES);
  const kept: string[] = [];
  /** Where the next read starts in the file: the raw offset, which is never the byte count. */
  let offset = 0;
  let bytes = 0;
  let keeping = true;
  let storable = true;
  /** Count one decoded piece of text: its UTF-8 size, the text rule, and whether it is still kept. */
  const append = (piece: string): void => {
    bytes += Buffer.byteLength(piece, "utf8");
    storable &&= isStorableRecordText(piece);
    if (keeping && bytes > budget) keeping = false;
    if (keeping) kept.push(piece);
  };
  for (;;) {
    const chunk = await handle.read(buffer, 0, RECORD_CHUNK_BYTES, offset);
    if (chunk.bytesRead === 0) break;
    offset += chunk.bytesRead;
    append(decoder.decode(buffer.subarray(0, chunk.bytesRead), { stream: true }));
  }
  // An incomplete trailing sequence decodes to the replacement character, which is storable.
  append(decoder.decode());
  return { ok: true, mtimeMs, bytes, storable, ...(keeping ? { text: kept.join("") } : {}) };
}

/**
 * One record file, read through the handle its metadata came from: no link is followed, a directory or
 * special file is refused, and only the bytes `budget` still allows are kept.
 */
async function readRecordFile(run: RunDir, file: HandoffRecordFile["file"], budget: number): Promise<FileRead> {
  if (file === RESULT_FILE) return await readChunks(run.result.handle, run.result.mtimeMs, budget);
  const opened = await openPlainFile(run.directory, file);
  if ("ok" in opened) return opened;
  try {
    return await readChunks(opened.handle, opened.mtimeMs, budget);
  } finally {
    await opened.handle.close();
  }
}

/** Every entry of the runs' record, in send order, or the first refusal the files produce. */
type RecordBuild =
  | { readonly ok: true; readonly record: readonly HandoffRecordFile[]; readonly bytes: number }
  | { readonly ok: false; readonly reason: string };

async function buildRecord(runs: readonly RunDir[]): Promise<RecordBuild> {
  const record: HandoffRecordFile[] = [];
  let bytes = 0;
  for (const run of runs) {
    for (const file of RECORD_FILES) {
      const read = await _handoffRecordDeps.readRecordFile(run, file, HANDOFF_RECORD_MAX_BYTES - bytes);
      if (!read.ok) {
        // A missing file is not part of the record; a link or a special file is refused, never read.
        if (read.absent) continue;
        return { ok: false, reason: notPlainFileReason(run.runId, file) };
      }
      if (!read.storable) {
        return {
          ok: false,
          reason: `${file} of run ${run.runId} holds a NUL or unpaired surrogate character, which koda refuses`,
        };
      }
      bytes += read.bytes;
      // The text is kept only while the record may still fit, so an absent one is over the cap, below.
      if (read.text !== undefined) record.push({ runId: run.runId, file, mtimeMs: read.mtimeMs, content: read.text });
    }
  }
  return { ok: true, record, bytes };
}

async function collectRuns(directory: FileHandle): Promise<HandoffRecordRead> {
  const runs: RunDir[] = [];
  let count = 0;
  try {
    for (const entry of await listHandoffChildren(directory)) {
      if (entry.kind === "link") return refusal(linkedRunReason(entry.name));
      const run = await inspectRun(directory, entry.name);
      if (typeof run === "string") return refusal(run);
      if (run === undefined) continue;
      count++;
      // Count all runs for the diagnostic, but never retain more descriptors than can be handed off.
      if (count <= HANDOFF_MAX_RUNS) runs.push(run);
      else await closeRun(run);
    }
    if (count === 0) return refusal(NO_FINISHED_RUN);
    if (count > HANDOFF_MAX_RUNS) {
      return refusal(`the feature has ${count} workflow runs; koda accepts at most ${HANDOFF_MAX_RUNS}`);
    }
    runs.sort((a, b) => b.result.mtimeMs - a.result.mtimeMs);
    // Compare the same integer mtimes koda receives.
    if (runs[0].result.mtimeMs === runs[1]?.result.mtimeMs) return refusal(NEWEST_TIE);
    const built = await buildRecord(runs);
    if (!built.ok) return refusal(built.reason);
    if (built.bytes > HANDOFF_RECORD_MAX_BYTES) {
      return refusal(`the run record is ${built.bytes} bytes; koda accepts at most ${HANDOFF_RECORD_MAX_BYTES}`);
    }
    return { ok: true, record: built.record, newestRunId: runs[0].runId };
  } finally {
    await Promise.all(runs.map(closeRun));
  }
}

/** Read workflow files below a trusted directory (the workflow directory's parent by default). */
export async function readHandoffRecordFiles(
  featureWorkflowDir: string,
  anchorDir: string = dirname(resolve(featureWorkflowDir)),
): Promise<HandoffRecordRead> {
  const root = resolve(anchorDir);
  const rest = relative(root, featureWorkflowDir);
  if (rest === ".." || rest.startsWith(`..${sep}`) || isAbsolute(rest)) {
    return refusal("the workflow directory is outside the trusted checkout");
  }
  let anchor: FileHandle;
  try {
    // The caller trusts this root, but not its descendants. Refuse a link in the root's final component too.
    anchor = await open(root, DIRECTORY_FLAGS);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return refusal(NO_FINISHED_RUN);
    throw error;
  }
  try {
    return await collectBelow(anchor, root, rest ? rest.split(sep) : []);
  } finally {
    await anchor.close();
  }
}

/** What the feature-record and PRD preflights read the record against (US-003). */
export interface HandoffRecordInput {
  readonly repoRoot: string;
  readonly feature: string;
  /** The pushed HEAD koda reads the record and the PRD at. */
  readonly head: string;
  /** The pushed branch, which the committed `prd.json` must name. */
  readonly branch: string;
}

/**
 * Injectable Git and record-file reads; overrides are read at call time.
 */
export const _handoffRecordDeps = {
  git: (args: string[], cwd: string) => gitWithTimeout(args, cwd),
  readRecordFile,
};

/** The committed file the handoff reads at the pushed HEAD. */
const PRD_FILE = "prd.json";
const NOT_A_FINISHED_RECORD = "the newest workflow run's result.json is not a finished feature record";
const HEAD_MOVED = "HEAD moved since the workflow finished; run nax run so the new commits are reviewed";
const PRD_NOT_COMMITTED = "prd.json is not committed at HEAD";
const PRD_NOT_A_PRD = "prd.json at HEAD is not a PRD";

/** A plain JSON object, not an array and not `null`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether the record's outcome says the run ended without a PR, which is the only kind a handoff sends. */
function isNoPrOutcome(outcome: unknown): boolean {
  return outcome === "pushed" || outcome === "local-only";
}

/** Whether the record's outcome says the run already published a PR, which a handoff cannot adopt. */
function isPublishedOutcome(outcome: unknown): outcome is "ready" | "draft" {
  return outcome === "ready" || outcome === "draft";
}

/**
 * The parsed PRD `pendingStoryIds` can read: an object whose `userStories` entries are all objects and
 * whose `branchName` is a name. koda's `readHandoffPrd` skips a non-object story instead; nax refuses
 * one, because `pendingStoryIds` cannot read it and would call a feature with work left finished.
 */
function isReadablePrd(parsed: unknown): parsed is PRD {
  if (!isRecord(parsed) || typeof parsed.branchName !== "string") return false;
  const stories = parsed.userStories;
  return Array.isArray(stories) && stories.every(isRecord);
}

/** The refusal for a PRD with stories still to run — singular for one, naming them in PRD order. */
function pendingReason(pending: readonly string[]): string {
  return `${pending.length} ${pending.length === 1 ? "story is" : "stories are"} still pending: ${pending.join(", ")}`;
}

function parseResultText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Validate the fields publish-only reads when it builds the feature's story summaries. */
function isSummarisableStory(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { state, reason, round, unreviewed, flagged } = value;
  return (
    (state === undefined ||
      state === "complete" ||
      state === "complete-with-rulings" ||
      state === "complete-gate-open") &&
    (reason === undefined || typeof reason === "string") &&
    typeof round === "number" &&
    typeof unreviewed === "boolean" &&
    (flagged === undefined || typeof flagged === "number")
  );
}

/**
 * The reason the newest `result.json` is not a finished no-PR record at `head`, or undefined when it is.
 * The checks are the Failure Handling table's order: the record's own shape, then the step it stopped at,
 * then the publication, then HEAD — so a run that already published is diagnosed before a moved HEAD.
 */
function unfinishedRecordReason(parsed: unknown, head: string): string | undefined {
  if (!isWorkflowResult(parsed) || !isFeatureRecord(parsed.featureWorkflow)) {
    return NOT_A_FINISHED_RECORD;
  }
  const { step, outcome, head: recordedHead, url } = parsed.featureWorkflow;
  // A done record with no known outcome never reached a finish, so it is not a finished record at all.
  if (step === "done" && !isNoPrOutcome(outcome) && !isPublishedOutcome(outcome)) return NOT_A_FINISHED_RECORD;
  if (step !== "done") return `the workflow stopped at ${String(step)}; run nax run to finish it`;
  if (isPublishedOutcome(outcome)) {
    const namedUrl = typeof url === "string" ? ` ${url}` : "";
    return `the run already published a ${outcome} PR${namedUrl}; a handoff needs a run that ended without a PR (publish "none")`;
  }
  if (recordedHead !== head) return HEAD_MOVED;
  return undefined;
}

/** The feature's PRD path as git reports it at a commit: repo-relative, from the `featureDir` SSOT. */
function committedPrdPath(repoRoot: string, feature: string): string {
  return relative(repoRoot, join(featureDir(repoRoot, feature), PRD_FILE));
}

/** The reason the PRD committed at the pushed HEAD cannot be handed over, or undefined when it can. */
async function committedPrdReason(input: HandoffRecordInput): Promise<string | undefined> {
  const path = committedPrdPath(input.repoRoot, input.feature);
  let shown: Awaited<ReturnType<typeof gitWithTimeout>>;
  try {
    shown = await _handoffRecordDeps.git(["show", `${input.head}:${path}`], input.repoRoot);
  } catch (error) {
    return `could not read prd.json at HEAD: Git failed: ${errorMessage(error)}`;
  }
  if (shown.timedOut === true) return "could not read prd.json at HEAD: Git timed out";
  // A non-zero exit means the file is not committed at that head.
  if (shown.exitCode !== 0) return PRD_NOT_COMMITTED;
  let parsed: unknown;
  try {
    parsed = JSON.parse(shown.stdout);
  } catch {
    // The committed file is not JSON, so it is not a PRD.
    return PRD_NOT_A_PRD;
  }
  if (!isReadablePrd(parsed)) return PRD_NOT_A_PRD;
  if (parsed.branchName !== input.branch) {
    return `prd.json names branch ${parsed.branchName}, not ${input.branch}`;
  }
  const pending = pendingStoryIds(parsed);
  return pending.length > 0 ? pendingReason(pending) : undefined;
}

/** Publish-only takes the newest feature state but can gather story records from any uploaded run. */
function publishRecordReason(read: Extract<HandoffRecordRead, { ok: true }>, head: string): string | undefined {
  for (const entry of read.record) {
    if (entry.file !== RESULT_FILE) continue;
    const parsed = parseResultText(entry.content);
    if (entry.runId === read.newestRunId) {
      const unfinished = unfinishedRecordReason(parsed, head);
      if (unfinished !== undefined) return unfinished;
    }
    // The receiving reader skips an unparseable or unrecognized older result envelope.
    if (
      isWorkflowResult(parsed) &&
      (!isRecord(parsed.stories) || !Object.values(parsed.stories).every(isSummarisableStory))
    ) {
      return `result.json of run ${entry.runId} contains invalid story records for publish-only`;
    }
  }
  return undefined;
}

/**
 * `readHandoffRecordFiles`, then the newest feature record and the PRD at `head` checked against koda's
 * rules (US-003): a record-file refusal is returned unchanged, and the two preflights stop at the first
 * failing check. Only the newest feature state is relevant, but publish-only can read story records
 * from older runs as well. An accepted read is the record itself, so what is sent is what was checked.
 *
 * The link check walks from the repository root, which is the one directory this module can trust, so a
 * `.nax`, `features` or feature directory that became a link is refused like a linked run.
 */
export async function collectHandoffRecord(input: HandoffRecordInput): Promise<HandoffRecordRead> {
  const read = await readHandoffRecordFiles(workflowFeatureDir(input.repoRoot, input.feature), input.repoRoot);
  if (!read.ok) return read;
  const recordReason = publishRecordReason(read, input.head);
  if (recordReason !== undefined) return refusal(recordReason);
  const prdReason = await committedPrdReason(input);
  if (prdReason !== undefined) return refusal(prdReason);
  return read;
}

/**
 * True when koda stores the text: no NUL character and no unpaired UTF-16 surrogate. A lone surrogate
 * cannot come out of UTF-8 decoding, but the check is applied to the string actually sent.
 */
export function isStorableRecordText(text: string): boolean {
  if (text.includes("\u0000")) return false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0xd800 || code > 0xdfff) continue;
    // A low surrogate here had no high surrogate before it; a high one needs its low half next.
    if (code > 0xdbff) return false;
    const next = text.charCodeAt(i + 1);
    if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    i += 1;
  }
  return true;
}
