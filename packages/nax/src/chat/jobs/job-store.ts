import { mkdirSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { NaxError } from "@/errors";
import { type ChatJob, type ChatJobKind, JOB_ID_PATTERN } from "./job-types";

export const CHAT_JOBS_DIR = "chat-jobs";
const RANDOM_HEX_LENGTH = 8;
const JOB_KINDS: readonly string[] = ["plan", "run", "bot_review", "bot_fix"];
const JOB_STATES: readonly string[] = ["running", "succeeded", "failed", "cancelled", "lost"];

export const _jobStoreDeps = {
  randomHex: (): string => crypto.randomUUID().slice(0, RANDOM_HEX_LENGTH),
  randomUUID: (): string => crypto.randomUUID(),
  file: Bun.file,
  write: Bun.write,
  mkdir: mkdirSync,
  readdir: readdirSync,
  rename: renameSync,
  unlink: unlinkSync,
};

export function jobsDir(outputDir: string): string {
  return join(outputDir, CHAT_JOBS_DIR);
}

export function jobLogPath(outputDir: string, id: string): string {
  return join(jobsDir(outputDir), `${id}.log`);
}

export function jobAsksDir(outputDir: string, jobId: string): string {
  return join(jobsDir(outputDir), `${jobId}.asks`);
}

export function newJobId(kind: ChatJobKind): string {
  return `${kind}-${_jobStoreDeps.randomHex()}`;
}

/** Publish only complete records; a unique sibling temp path also isolates concurrent writers. */
export async function writeJobRecord(outputDir: string, job: ChatJob): Promise<void> {
  if (!JOB_ID_PATTERN.test(job.id)) {
    throw new NaxError(`[chat-jobs] Invalid job id: ${job.id}`, "CHAT_JOB_INVALID_ID", { stage: "chat-jobs" });
  }
  const dir = jobsDir(outputDir);
  const temp = join(dir, `${job.id}.${_jobStoreDeps.randomUUID()}.tmp`);
  try {
    _jobStoreDeps.mkdir(dir, { recursive: true });
    await _jobStoreDeps.write(temp, JSON.stringify(job, null, 2));
    _jobStoreDeps.rename(temp, join(dir, `${job.id}.json`));
  } catch (cause) {
    const cleanupCause = removeTemp(temp);
    throw new NaxError(`[chat-jobs] Failed to write job ${job.id}`, "CHAT_JOB_WRITE_FAILED", {
      stage: "chat-jobs",
      id: job.id,
      cause,
      cleanupCause,
    });
  }
}

/** Retain cleanup failures in the write error without masking its original cause. */
function removeTemp(path: string): unknown {
  try {
    _jobStoreDeps.unlink(path);
  } catch (err) {
    if (!isMissing(err)) return err;
  }
  return undefined;
}

function isMissing(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

/** Minimum durable recovery contract; preserve other fields without projecting them away. */
function isJobRecord(value: unknown): value is ChatJob {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    typeof record.id === "string" &&
    JOB_ID_PATTERN.test(record.id) &&
    typeof record.kind === "string" &&
    JOB_KINDS.includes(record.kind) &&
    typeof record.state === "string" &&
    JOB_STATES.includes(record.state) &&
    typeof record.pid === "number" &&
    ["cwd", "startedAt", "logPath", "sessionId"].every((key) => typeof record[key] === "string")
  );
}

async function readRecord(path: string): Promise<ChatJob | null> {
  try {
    const value: unknown = await _jobStoreDeps.file(path).json();
    return isJobRecord(value) ? value : null;
  } catch (err) {
    // Malformed JSON and records removed during a read are ordinary recovery skips.
    if (err instanceof SyntaxError || isMissing(err)) return null;
    throw err;
  }
}

/** Missing stores are ordinary absence; unexpected I/O failures remain visible. */
export async function readJobRecords(outputDir: string): Promise<ChatJob[]> {
  const dir = jobsDir(outputDir);
  let names: string[];
  try {
    names = _jobStoreDeps.readdir(dir);
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
  const records = await Promise.all(
    names.filter((name) => name.endsWith(".json")).map((name) => readRecord(join(dir, name))),
  );
  return records
    .filter((record): record is ChatJob => record !== null)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
