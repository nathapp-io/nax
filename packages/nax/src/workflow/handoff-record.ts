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
 * Nothing here follows a link: a run is a real directory under the feature's workflow dir, a record file
 * is a regular file, and each file is read through the same handle its metadata came from — so the text
 * the approval card counts as the feature's own record is the text that is there, and a link to a file
 * outside the tree is refused rather than uploaded under `ledger.md`. Files are streamed in chunks, so
 * an oversized run is counted and refused without ever being held in memory whole.
 */
import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { featureDir } from "@/config";
import { type PRD, pendingStoryIds } from "@/prd";
import { gitWithTimeout } from "@/utils/git";
import { ledgerFilePath } from "./ledger";
import { workflowFeatureDir } from "./paths";

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
/** Read-only, and never through a link: a record file is opened as a plain file or not at all. */
const RECORD_FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;

/** A run directory that has a result.json, with the stat mtime the ordering uses. */
interface RunDir {
  readonly runId: string;
  readonly runDir: string;
  readonly mtimeMs: number;
}

/** The runs a handoff may read, or the refusal for a run directory it must not read through. */
type RunListing =
  | { readonly ok: true; readonly runs: readonly RunDir[] }
  | { readonly ok: false; readonly reason: string };

/** One record file as its own verified handle reported it. */
type FileRead =
  | {
      readonly ok: true;
      /** The handle's mtime, truncated — the integer koda compares. */
      readonly mtimeMs: number;
      /** The file's exact byte length, which the record's total counts even past the cap. */
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

/** errno codes that mean "there is no such path" — the only stat failures a run listing reads as absence. */
const MISSING_PATH_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);

function refusal(reason: string): HandoffRecordRead {
  return { ok: false, reason };
}

/** The errno code of a thrown filesystem error, when it carries one. */
function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

/**
 * The path's own stat, or undefined when there is no such path. `lstat` does not follow a link, so a
 * link answers as a link instead of as whatever it points at. Every other failure — an unreadable run
 * directory, a link loop in a path component — propagates, so a run the handoff cannot read never drops
 * out of the record and leaves an older run posing as the newest.
 */
async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (err) {
    const code = errnoCode(err);
    if (code !== undefined && MISSING_PATH_CODES.has(code)) return undefined;
    throw err;
  }
}

/**
 * The directory's entries, or `[]` when there is no such directory. Any other failure — a workflow dir
 * that cannot be read — propagates, for the same reason a failed stat does.
 */
async function readdirOrEmpty(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (err) {
    const code = errnoCode(err);
    if (code !== undefined && MISSING_PATH_CODES.has(code)) return [];
    throw err;
  }
}

/** A record file that is a link or a special file, which the handoff refuses to send. */
function notPlainFileReason(runId: string, file: HandoffRecordFile["file"]): string {
  return `${file} of run ${runId} is a link or a special file, not a regular file the handoff can read`;
}

/** A run that is not a real directory of this feature, so its files are not this feature's record. */
function linkedRunReason(runId: string): string {
  return `the workflow run ${runId} is a link, not a run directory of this feature; the handoff reads only the feature's own runs`;
}

/**
 * Every run directory under `featureWorkflowDir` that holds a result.json, newest result.json first — the
 * order `runDirsNewestFirst` uses. A workflow dir that does not exist and a stray file in place of a run
 * both read as "no run there"; a link in place of a run, and anything else the filesystem refuses, are
 * refused: following one would send files from outside the feature's own tree.
 */
async function listRunDirs(featureWorkflowDir: string): Promise<RunListing> {
  const runs: RunDir[] = [];
  for (const runId of await readdirOrEmpty(featureWorkflowDir)) {
    const runDir = join(featureWorkflowDir, runId);
    const runStats = await lstatOrUndefined(runDir);
    if (runStats === undefined) continue;
    if (runStats.isSymbolicLink()) return { ok: false, reason: linkedRunReason(runId) };
    if (!runStats.isDirectory()) continue;
    const resultStats = await lstatOrUndefined(join(runDir, RESULT_FILE));
    if (resultStats === undefined) continue;
    if (!resultStats.isFile()) return { ok: false, reason: notPlainFileReason(runId, RESULT_FILE) };
    runs.push({ runId, runDir, mtimeMs: resultStats.mtimeMs });
  }
  return { ok: true, runs: runs.sort((a, b) => b.mtimeMs - a.mtimeMs) };
}

/** The file's handle, or why it cannot be read: no such file, or a link that `O_NOFOLLOW` refused. */
async function openPlainFile(path: string): Promise<FileHandle | FileRead> {
  try {
    return await open(path, RECORD_FILE_FLAGS);
  } catch (err) {
    const code = errnoCode(err);
    if (code !== undefined && MISSING_PATH_CODES.has(code)) return { ok: false, absent: true };
    // ELOOP: the path became a link after the listing checked it. A link is never read through.
    if (code === "ELOOP") return { ok: false, absent: false };
    throw err;
  }
}

/**
 * One open record file, read a chunk at a time: every byte is counted, and at most the remaining budget
 * is kept. Each decoded chunk is checked for the text koda refuses; `TextDecoder` with `stream: true`
 * holds an incomplete character back, so a chunk never ends inside a surrogate pair.
 */
async function readChunks(handle: FileHandle, mtimeMs: number, budget: number): Promise<FileRead> {
  const decoder = new TextDecoder();
  const buffer = Buffer.alloc(RECORD_CHUNK_BYTES);
  const kept: string[] = [];
  let bytes = 0;
  let keeping = true;
  let storable = true;
  for (;;) {
    const chunk = await handle.read(buffer, 0, RECORD_CHUNK_BYTES, bytes);
    if (chunk.bytesRead === 0) break;
    bytes += chunk.bytesRead;
    const piece = decoder.decode(buffer.subarray(0, chunk.bytesRead), { stream: true });
    storable &&= isStorableRecordText(piece);
    if (keeping && bytes > budget) keeping = false;
    if (keeping) kept.push(piece);
  }
  // An incomplete trailing sequence decodes to the replacement character, which is storable.
  const tail = decoder.decode();
  storable &&= isStorableRecordText(tail);
  if (keeping) kept.push(tail);
  return { ok: true, mtimeMs, bytes, storable, ...(keeping ? { text: kept.join("") } : {}) };
}

/**
 * One record file, read through the handle its metadata came from: no link is followed, a directory or
 * special file is refused, and only the bytes `budget` still allows are kept.
 */
async function readRecordFile(path: string, budget: number): Promise<FileRead> {
  const opened = await openPlainFile(path);
  if ("ok" in opened) return opened;
  try {
    const stats = await opened.stat();
    if (!stats.isFile()) return { ok: false, absent: false };
    return await readChunks(opened, Math.trunc(stats.mtimeMs), budget);
  } finally {
    await opened.close();
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
      const path = file === RESULT_FILE ? join(run.runDir, RESULT_FILE) : ledgerFilePath(run.runDir);
      const read = await readRecordFile(path, HANDOFF_RECORD_MAX_BYTES - bytes);
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

/** koda orders runs by the truncated integer mtime, so two runs sharing the newest one cannot be ordered. */
function newestTie(runs: readonly RunDir[]): boolean {
  const newest = Math.trunc(runs[0].mtimeMs);
  return runs.filter((run) => Math.trunc(run.mtimeMs) === newest).length > 1;
}

/** The files of every run that has a result.json, newest run first (US-002). */
export async function readHandoffRecordFiles(featureWorkflowDir: string): Promise<HandoffRecordRead> {
  const listing = await listRunDirs(featureWorkflowDir);
  if (!listing.ok) return refusal(listing.reason);
  const { runs } = listing;
  if (runs.length === 0) return refusal(NO_FINISHED_RUN);
  if (runs.length > HANDOFF_MAX_RUNS) {
    return refusal(`the feature has ${runs.length} workflow runs; koda accepts at most ${HANDOFF_MAX_RUNS}`);
  }
  if (newestTie(runs)) return refusal(NEWEST_TIE);
  const built = await buildRecord(runs);
  if (!built.ok) return refusal(built.reason);
  if (built.bytes > HANDOFF_RECORD_MAX_BYTES) {
    return refusal(`the run record is ${built.bytes} bytes; koda accepts at most ${HANDOFF_RECORD_MAX_BYTES}`);
  }
  return { ok: true, record: built.record, newestRunId: runs[0].runId };
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
 * The module's one process. `git` is stubbed in tests, the pattern `_configChangeDeps.git` uses; an
 * override here is read at call time, never captured.
 */
export const _handoffRecordDeps = {
  git: (args: string[], cwd: string) => gitWithTimeout(args, cwd),
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

/**
 * The reason the newest `result.json` is not a finished no-PR record at `head`, or undefined when it is.
 * The checks are the Failure Handling table's order: the record's own shape, then the step it stopped at,
 * then the publication, then HEAD — so a run that already published is diagnosed before a moved HEAD.
 */
function unfinishedRecordReason(resultText: string, head: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultText);
  } catch {
    // A record that does not parse cannot say what the run did.
    return NOT_A_FINISHED_RECORD;
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isRecord(parsed.featureWorkflow)) {
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
  let shown: { stdout: string; exitCode: number };
  try {
    shown = await _handoffRecordDeps.git(["show", `${input.head}:${path}`], input.repoRoot);
  } catch {
    // git could not answer at all. That and a non-zero exit are one answer: the file is not readable
    // at this head, so the handoff has nothing to send koda.
    return PRD_NOT_COMMITTED;
  }
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

/** The newest run's `result.json` entry, or undefined when the record holds none (it always does). */
function newestResultEntry(read: Extract<HandoffRecordRead, { ok: true }>): HandoffRecordFile | undefined {
  return read.record.find((entry) => entry.runId === read.newestRunId && entry.file === RESULT_FILE);
}

/**
 * `readHandoffRecordFiles`, then the newest feature record and the PRD at `head` checked against koda's
 * rules (US-003): a record-file refusal is returned unchanged, and the two preflights stop at the first
 * failing check. The newest record only — an older one describes code this handoff would not send — and
 * an accepted read is the record itself, so what is sent is exactly what was checked.
 */
export async function collectHandoffRecord(input: HandoffRecordInput): Promise<HandoffRecordRead> {
  const read = await readHandoffRecordFiles(workflowFeatureDir(input.repoRoot, input.feature));
  if (!read.ok) return read;
  const newest = newestResultEntry(read);
  const recordReason =
    newest === undefined ? NOT_A_FINISHED_RECORD : unfinishedRecordReason(newest.content, input.head);
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
