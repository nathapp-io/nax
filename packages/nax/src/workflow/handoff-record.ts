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
 */
import type { Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
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
const NO_FINISHED_RUN = "no finished workflow run for this feature; run nax run first";
const NEWEST_TIE = "two workflow runs share the newest result.json time, so the newest run is ambiguous";

/** A run directory that has a result.json, with the stat mtime the ordering uses. */
interface RunDir {
  readonly runId: string;
  readonly runDir: string;
  readonly mtimeMs: number;
}

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
 * The file's stat, or undefined when there is no such path. Every other failure — an unreadable run
 * directory, a symlink loop — propagates, so a run the handoff cannot read never drops out of the record
 * and leaves an older run posing as the newest.
 */
async function statOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
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

/**
 * Every run directory under `featureWorkflowDir` that holds a result.json, newest result.json first — the
 * order `runDirsNewestFirst` uses. A workflow dir that does not exist and a stray file in place of a run
 * both read as "no run there"; anything else the filesystem refuses is a failure the caller must see.
 */
async function listRunDirs(featureWorkflowDir: string): Promise<RunDir[]> {
  const runs: RunDir[] = [];
  for (const runId of await readdirOrEmpty(featureWorkflowDir)) {
    const runDir = join(featureWorkflowDir, runId);
    const stats = await statOrUndefined(join(runDir, RESULT_FILE));
    if (stats === undefined) continue;
    runs.push({ runId, runDir, mtimeMs: stats.mtimeMs });
  }
  return runs.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** One file of a run, or undefined when the run does not hold it. */
async function fileEntry(
  run: RunDir,
  path: string,
  file: HandoffRecordFile["file"],
): Promise<HandoffRecordFile | undefined> {
  const stats = await statOrUndefined(path);
  if (stats === undefined) return undefined;
  // A read failure is not "no file": it would silently send a record the handoff was meant to complete.
  return { runId: run.runId, file, mtimeMs: Math.trunc(stats.mtimeMs), content: await Bun.file(path).text() };
}

/** A run's files in send order: result.json, then ledger.md when the run has one. */
async function runEntries(run: RunDir): Promise<HandoffRecordFile[]> {
  const entries = [await fileEntry(run, join(run.runDir, RESULT_FILE), RESULT_FILE)];
  entries.push(await fileEntry(run, ledgerFilePath(run.runDir), "ledger.md"));
  return entries.filter((entry) => entry !== undefined);
}

/** The first entry whose text koda would refuse, or undefined when every one is storable. */
function unstorableEntry(record: readonly HandoffRecordFile[]): HandoffRecordFile | undefined {
  return record.find((entry) => !isStorableRecordText(entry.content));
}

/** The UTF-8 size of everything the handoff would send, which is what koda's cap measures. */
function recordBytes(record: readonly HandoffRecordFile[]): number {
  return record.reduce((total, entry) => total + Buffer.byteLength(entry.content, "utf8"), 0);
}

/** koda orders runs by the truncated integer mtime, so two runs sharing the newest one cannot be ordered. */
function newestTie(runs: readonly RunDir[]): boolean {
  const newest = Math.trunc(runs[0].mtimeMs);
  return runs.filter((run) => Math.trunc(run.mtimeMs) === newest).length > 1;
}

/** The files of every run that has a result.json, newest run first (US-002). */
export async function readHandoffRecordFiles(featureWorkflowDir: string): Promise<HandoffRecordRead> {
  const runs = await listRunDirs(featureWorkflowDir);
  if (runs.length === 0) return refusal(NO_FINISHED_RUN);
  if (runs.length > HANDOFF_MAX_RUNS) {
    return refusal(`the feature has ${runs.length} workflow runs; koda accepts at most ${HANDOFF_MAX_RUNS}`);
  }
  if (newestTie(runs)) return refusal(NEWEST_TIE);
  const record: HandoffRecordFile[] = [];
  for (const run of runs) record.push(...(await runEntries(run)));
  const unstorable = unstorableEntry(record);
  if (unstorable !== undefined) {
    return refusal(
      `${unstorable.file} of run ${unstorable.runId} holds a NUL or unpaired surrogate character, which koda refuses`,
    );
  }
  const bytes = recordBytes(record);
  if (bytes > HANDOFF_RECORD_MAX_BYTES) {
    return refusal(`the run record is ${bytes} bytes; koda accepts at most ${HANDOFF_RECORD_MAX_BYTES}`);
  }
  return { ok: true, record, newestRunId: runs[0].runId };
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
