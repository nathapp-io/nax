/**
 * The run record a chat chain hands to koda (chat-flow-handoff US-002): `.nax/features/<feature>/workflow/`
 * is git-excluded and lives only on the machine that ran the chain, so a handoff uploads the newest runs'
 * `result.json` and `ledger.md` instead of pointing koda at them. What is sent is bounded by koda's own
 * shape limits (`packages/fleet-protocol/src/index.ts` in koda), so every refusal here repeats a rule
 * koda would apply to the same body.
 */
import type { Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { ledgerFilePath } from "./ledger";

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
