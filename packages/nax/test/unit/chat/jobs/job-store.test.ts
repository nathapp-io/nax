import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import type { ChatJob } from "@/chat/jobs/job-types";
import { NaxError } from "@/errors";

let dir: string;
let store: typeof import("@/chat/jobs/job-store");
let types: typeof import("@/chat/jobs/job-types");
let originalDeps: typeof store._jobStoreDeps;

beforeEach(async () => {
  dir = makeTempDir("chat-jobs-");
  store = await import("@/chat/jobs/job-store");
  types = await import("@/chat/jobs/job-types");
  originalDeps = { ...store._jobStoreDeps };
});
afterEach(() => {
  if (store && originalDeps) Object.assign(store._jobStoreDeps, originalDeps);
  cleanupTempDir(dir);
});

function job(overrides: Partial<ChatJob> = {}): ChatJob {
  return {
    schemaVersion: 1,
    id: "run-1a2b3c4d",
    kind: "run",
    target: "feature",
    argv: ["run", "-f", "feature"],
    cwd: dir,
    pid: 123,
    startedAt: "2026-10-01T00:00:00Z",
    state: "running",
    logPath: join(dir, "chat-jobs", "run-1a2b3c4d.log"),
    sessionId: "session-1",
    approvedAt: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

async function rawRecord(value: unknown): Promise<void> {
  await Bun.write(join(dir, "chat-jobs", "x.json"), JSON.stringify(value));
}

describe("jobsDir", () => {
  test("AC-1 joins the project output directory", () => {
    expect(store.CHAT_JOBS_DIR).toBe("chat-jobs");
    expect(store.jobsDir("/o")).toBe("/o/chat-jobs");
  });
});
describe("jobLogPath", () => {
  test("AC-2 returns the job log path", () => {
    expect(store.jobLogPath("/o", "run-1a2b3c4d")).toBe("/o/chat-jobs/run-1a2b3c4d.log");
  });
});
describe("newJobId", () => {
  test("AC-3 uses the injectable random suffix", () => {
    store._jobStoreDeps.randomHex = () => "1a2b3c4d";
    expect(store.newJobId("run")).toBe("run-1a2b3c4d");
  });
  test("defaults to eight lowercase hex characters for every kind", () => {
    for (const kind of ["plan", "run", "bot_review", "bot_fix"] as const) {
      expect(types.JOB_ID_PATTERN.test(store.newJobId(kind))).toBe(true);
    }
  });
});
describe("JOB_ID_PATTERN", () => {
  test("AC-4 accepts a bot fix id", () => {
    expect(types.JOB_ID_PATTERN.test("bot_fix-0f0f0f0f")).toBe(true);
  });
  test("AC-5 rejects traversal", () => {
    expect(types.JOB_ID_PATTERN.test("run-../../x")).toBe(false);
  });
});
describe("writeJobRecord", () => {
  test("AC-6 round trips the full record", async () => {
    const record = job({
      endedAt: "2026-10-02T00:00:00Z",
      state: "failed",
      exitCode: 1,
      cost: 0.25,
      progress: { passed: 2, total: 3 },
      note: "failed",
      cancelRequested: true,
    });
    await store.writeJobRecord(dir, record);
    expect(await store.readJobRecords(dir)).toEqual([record]);
  });
  test("AC-7 replaces an existing record", async () => {
    await store.writeJobRecord(dir, job());
    const updated = job({ state: "succeeded", exitCode: 0 });
    await store.writeJobRecord(dir, updated);
    expect(await store.readJobRecords(dir)).toEqual([updated]);
  });
  test("AC-13 publishes via rename and leaves only the record", async () => {
    const rename = store._jobStoreDeps.rename;
    let renamed = false;
    store._jobStoreDeps.rename = (from, to) => {
      expect(from).not.toBe(to);
      expect(Bun.file(from).size).toBeGreaterThan(0);
      expect(readdirSync(store.jobsDir(dir))).not.toContain(`${job().id}.json`);
      renamed = true;
      return rename(from, to);
    };
    await store.writeJobRecord(dir, job());
    expect(renamed).toBe(true);
    expect(readdirSync(store.jobsDir(dir))).toEqual([`${job().id}.json`]);
  });
  test("retains the old record and cleans up when rename fails", async () => {
    await store.writeJobRecord(dir, job());
    const cause = new NaxError("rename failed", "TEST_FAILURE", { stage: "test" });
    store._jobStoreDeps.rename = () => {
      throw cause;
    };
    await expect(store.writeJobRecord(dir, job({ state: "failed" }))).rejects.toMatchObject({
      code: "CHAT_JOB_WRITE_FAILED",
      context: { cause },
    });
    expect(await store.readJobRecords(dir)).toEqual([job()]);
    expect(readdirSync(store.jobsDir(dir))).toEqual([`${job().id}.json`]);
  });
  test("rejects an unsafe id before writing", async () => {
    await expect(store.writeJobRecord(dir, job({ id: "../escape" }))).rejects.toThrow("id");
    expect(readdirSync(dir)).toEqual([]);
  });
});
describe("readJobRecords", () => {
  test("AC-8 sorts newest first", async () => {
    const older = job();
    const newer = job({ id: "plan-00000000", kind: "plan", startedAt: "2026-10-02T00:00:00Z" });
    await store.writeJobRecord(dir, older);
    await store.writeJobRecord(dir, newer);
    expect(await store.readJobRecords(dir)).toEqual([newer, older]);
  });
  test("AC-9 skips malformed JSON without losing valid records", async () => {
    await store.writeJobRecord(dir, job());
    await Bun.write(join(store.jobsDir(dir), "x.json"), "not json");
    expect(await store.readJobRecords(dir)).toEqual([job()]);
  });
  test("AC-10 skips an unknown state", async () => {
    await rawRecord({ ...job(), state: "paused" });
    expect(await store.readJobRecords(dir)).toEqual([]);
  });
  test("AC-11 skips a traversal id", async () => {
    await rawRecord({ ...job(), id: "../escape" });
    expect(await store.readJobRecords(dir)).toEqual([]);
  });
  test("AC-12 returns empty for a missing directory", async () => {
    expect(await store.readJobRecords(dir)).toEqual([]);
  });
  test.each([
    null,
    { invalidArray: true },
    { schemaVersion: 2 },
    { id: 123 },
    { kind: "unknown" },
    { pid: "123" },
    { cwd: null },
    { startedAt: 1 },
    { logPath: false },
    { sessionId: null },
  ])("skips invalid required shape %j", async (invalid) => {
    await store.writeJobRecord(dir, job());
    await rawRecord(invalid === null ? null : "invalidArray" in invalid ? [] : { ...job(), ...invalid });
    expect(await store.readJobRecords(dir)).toEqual([job()]);
  });
  test("ignores logs and temporary files", async () => {
    await store.writeJobRecord(dir, job());
    await Bun.write(join(store.jobsDir(dir), "extra.log"), JSON.stringify(job()));
    await Bun.write(join(store.jobsDir(dir), "extra.tmp"), JSON.stringify(job()));
    expect(await store.readJobRecords(dir)).toEqual([job()]);
  });
});
