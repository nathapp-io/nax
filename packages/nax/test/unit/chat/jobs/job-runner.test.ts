import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeFakeClock, makeTempDir } from "@test/helpers";
import { _jobRunnerDeps, createJobRunner, JOB_POLL_MS, type StartJobRequest } from "@/chat/jobs/job-runner";
import { _jobStoreDeps, jobAsksDir, jobLogPath, jobsDir, readJobRecords } from "@/chat/jobs/job-store";
import { featureDir } from "@/config";
import { NaxError } from "@/errors";
import { chatHeartbeatFresh } from "@/interaction/chat-ask-files";

const originalDeps = { ..._jobRunnerDeps };
const originalStoreDeps = { ..._jobStoreDeps };
let repoRoot: string;
let outputDir: string;
let clock: ReturnType<typeof makeFakeClock>;
let exit: (code: number) => void;
let child: {
  pid: number;
  exited: Promise<number>;
  unref: ReturnType<typeof mock>;
  stdin: { write: ReturnType<typeof mock>; end: ReturnType<typeof mock> };
};
const request: StartJobRequest = {
  kind: "run",
  target: "f1",
  argv: ["bun", "nax.js", "run", "-f", "f1", "--headless"],
  sessionId: "chat-1",
  approvedAt: "2026-10-01T00:00:00Z",
};

beforeEach(() => {
  repoRoot = makeTempDir("job-runner-");
  outputDir = join(repoRoot, "output");
  clock = makeFakeClock();
  const deferred = Promise.withResolvers<number>();
  exit = deferred.resolve;
  child = {
    pid: 4242,
    exited: deferred.promise,
    unref: mock(() => {}),
    stdin: { write: mock(() => 65), end: mock(() => 0) },
  };
  Object.assign(_jobRunnerDeps, {
    spawn: mock(() => child),
    kill: mock(() => true),
    isProcessAlive: mock(() => true),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    openLog: mock(() => 73),
    closeLog: mock(() => {}),
  });
});
afterEach(() => {
  Object.assign(_jobRunnerDeps, originalDeps);
  Object.assign(_jobStoreDeps, originalStoreDeps);
  cleanupTempDir(repoRoot);
});
function runner() {
  return createJobRunner({ repoRoot, outputDir, now: () => new Date(clock.now()) });
}

// Wait for the runner's durable terminal notification, not a fixed sleep or microtask count.
function nextChange(jobs: ReturnType<typeof runner>): Promise<void> {
  return new Promise((resolve) => {
    const off = jobs.onChange(() => {
      off();
      resolve();
    });
  });
}

describe("createJobRunner", () => {
  test.each(["run", "bot_review", "bot_fix"] as const)(
    "US-008 AC-2/3/4/9/10/14/15/16/18 transports %s asks and memory-only secret",
    async (kind) => {
      const secret = new Uint8Array(32).fill(0xab);
      _jobRunnerDeps.randomSecret = mock(() => secret);
      const argv = [...request.argv];
      const jobs = runner();
      try {
        const job = await jobs.start({ ...request, kind, argv });
        const spawned = [...argv, "--chat-asks", jobAsksDir(outputDir, job.id)];
        expect(_jobRunnerDeps.spawn).toHaveBeenCalledWith(spawned, expect.objectContaining({ stdin: "pipe" }));
        expect(job.argv).toEqual(spawned);
        expect(argv).toEqual([...request.argv]);
        expect(child.stdin.write).toHaveBeenCalledWith(`${Buffer.from(secret).toString("hex")}\n`);
        expect(child.stdin.end).toHaveBeenCalledTimes(1);
        expect(child.stdin.write.mock.invocationCallOrder[0]).toBeLessThan(
          child.stdin.end.mock.invocationCallOrder[0] ?? 0,
        );
        expect(jobs.askSecret?.(job.id)).toEqual(secret);
        const record = await Bun.file(join(jobsDir(outputDir), `${job.id}.json`)).text();
        expect(record).not.toContain(Buffer.from(secret).toString("hex"));
      } finally {
        jobs.dispose();
      }
    },
  );
  test("US-008 AC-5/6 plan keeps argv and ignored stdin without preparing asks", async () => {
    _jobRunnerDeps.createAsksDir = mock(async () => {});
    _jobRunnerDeps.randomSecret = mock(() => new Uint8Array(32));
    const jobs = runner();
    try {
      const job = await jobs.start({ ...request, kind: "plan" });
      expect(_jobRunnerDeps.spawn).toHaveBeenCalledWith(request.argv, expect.objectContaining({ stdin: "ignore" }));
      expect(_jobRunnerDeps.createAsksDir).not.toHaveBeenCalled();
      expect(_jobRunnerDeps.randomSecret).not.toHaveBeenCalled();
      expect(child.stdin.write).not.toHaveBeenCalled();
      expect(jobs.askSecret?.(job.id)).toBeUndefined();
    } finally {
      jobs.dispose();
    }
  });
  test("US-008 AC-7 prepares asks with the clock Date before spawn", async () => {
    const now = new Date("2026-10-27T00:00:00Z");
    const events: string[] = [];
    _jobRunnerDeps.createAsksDir = mock(async (_dir, date) => {
      expect(date).toBe(now);
      events.push("prepare");
    });
    _jobRunnerDeps.spawn = mock(() => {
      events.push("spawn");
      return child;
    });
    const jobs = createJobRunner({ repoRoot, outputDir, now: () => now });
    try {
      const job = await jobs.start(request);
      expect(_jobRunnerDeps.createAsksDir).toHaveBeenCalledWith(jobAsksDir(outputDir, job.id), now);
      expect(events).toEqual(["prepare", "spawn"]);
    } finally {
      jobs.dispose();
    }
  });
  test("US-008 AC-8/19 real preparation publishes a fresh heartbeat and private directory before spawn", async () => {
    const now = new Date("2026-10-27T00:00:00Z");
    let freshness: Promise<boolean> | undefined;
    _jobRunnerDeps.spawn = mock((argv) => {
      const dir = argv.at(-1) ?? "";
      freshness = chatHeartbeatFresh(dir, now.getTime());
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      return child;
    });
    const jobs = createJobRunner({ repoRoot, outputDir, now: () => now });
    try {
      await jobs.start(request);
      expect(await freshness).toBe(true);
    } finally {
      jobs.dispose();
    }
  });
  test("US-008 AC-11/12 failed preparation launches unchanged argv with warning", async () => {
    _jobRunnerDeps.createAsksDir = mock(async () => {
      throw new Error("disk full");
    });
    const jobs = runner();
    try {
      const job = await jobs.start(request);
      expect(_jobRunnerDeps.spawn).toHaveBeenCalledWith(request.argv, expect.anything());
      expect(job.argv).toEqual(request.argv);
      expect(job.note).toContain("asks will not reach the chat");
    } finally {
      jobs.dispose();
    }
  });
  test.each(["write", "end"] as const)("F1 secret %s failure surfaces a durable no-retry warning", async (phase) => {
    child.stdin[phase] = mock(async () => {
      throw new Error("pipe closed");
    });
    const jobs = runner();
    try {
      const job = await jobs.start(request);
      expect(job.note).toContain("asks will not reach the chat");
      expect(job.note).toContain("secret delivery failed");
      expect(job.note).toContain("do not retry");
      expect(jobs.get(job.id)?.note).toBe(job.note);
      expect((await readJobRecords(outputDir))[0]?.note).toBe(job.note);
      expect(jobs.askSecret?.(job.id)).toBeUndefined();
      expect(jobs.owned()).toEqual([job]);
      expect(child.stdin.end).toHaveBeenCalledTimes(1);
      expect(_jobRunnerDeps.spawn).toHaveBeenCalledTimes(1);
      expect(_jobRunnerDeps.kill).not.toHaveBeenCalled();
    } finally {
      jobs.dispose();
    }
  });
  test("preparation and persistence failures preserve both warnings on the managed launch", async () => {
    _jobRunnerDeps.createAsksDir = mock(async () => {
      throw new Error("no heartbeat");
    });
    _jobStoreDeps.rename = mock(() => {
      throw new Error("no record");
    });
    const jobs = runner();
    try {
      const job = await jobs.start(request);
      expect(job.note).toContain("asks will not reach the chat");
      expect(job.note).toContain("do not retry");
      expect(jobs.owned()).toEqual([job]);
    } finally {
      jobs.dispose();
    }
  });
  test("US-008 AC-17 attached jobs never recover secrets", async () => {
    const jobs = runner();
    const attached = runner();
    try {
      const job = await jobs.start(request);
      await attached.attach();
      expect(attached.get(job.id)?.id).toBe(job.id);
      expect(typeof attached.askSecret).toBe("function");
      expect(attached.askSecret?.(job.id)).toBeUndefined();
    } finally {
      jobs.dispose();
      attached.dispose();
    }
  });
  test("stopLaunching fences new starts and settles admitted launches without cancelling them", async () => {
    const jobs = runner();
    try {
      const changed = mock(() => {});
      jobs.onChange(changed);
      const starting = jobs.start(request);
      expect(changed).not.toHaveBeenCalled();
      const stopped = jobs.stopLaunching();
      await expect(jobs.start(request)).rejects.toMatchObject({ code: "CHAT_JOB_CLOSED" });
      await stopped;
      expect(changed).toHaveBeenCalledTimes(2);
      expect(jobs.owned()).toEqual([await starting]);
      expect(_jobRunnerDeps.spawn).toHaveBeenCalledTimes(1);
      expect(_jobRunnerDeps.kill).not.toHaveBeenCalled();
    } finally {
      jobs.dispose();
    }
  });
  test("US-006 AC-20 persists chain identity from start request", async () => {
    const jobs = runner();
    try {
      const chained = { ...request, chainId: "chain-1a2b3c4d", chainStep: 2 };
      await jobs.start(chained);
      expect((await readJobRecords(outputDir))[0]).toMatchObject({ chainId: chained.chainId, chainStep: 2 });
    } finally {
      jobs.dispose();
    }
  });
  test("AC-1,2,4,5,6,7 spawns detached with one append log fd and closes it in order", async () => {
    const events: string[] = [];
    _jobRunnerDeps.openLog = mock(() => {
      expect(existsSync(jobsDir(outputDir))).toBe(true);
      events.push("open");
      return 73;
    });
    _jobRunnerDeps.spawn = mock(() => {
      events.push("spawn");
      return child;
    });
    _jobRunnerDeps.closeLog = mock(() => {
      events.push("close");
    });
    const job = await runner().start(request);
    expect(_jobRunnerDeps.spawn).toHaveBeenCalledWith([...request.argv, "--chat-asks", jobAsksDir(outputDir, job.id)], {
      cwd: repoRoot,
      detached: true,
      stdin: "pipe",
      stdout: 73,
      stderr: 73,
    });
    expect(_jobRunnerDeps.openLog).toHaveBeenCalledWith(jobLogPath(outputDir, job.id));
    expect(_jobRunnerDeps.closeLog).toHaveBeenCalledWith(73);
    expect(events).toEqual(["open", "spawn", "close"]);
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  test("AC-3,15,17 registers after transport preparation, persists running identity and emits at registration and persistence", async () => {
    const jobs = runner();
    const changed = mock(() => {});
    jobs.onChange(changed);
    const starting = jobs.start(request);
    const job = await starting;
    expect(jobs.running()).toHaveLength(1);
    const records = await readJobRecords(outputDir);
    expect(records).toHaveLength(1);
    const record = records[0];
    expect({ state: record?.state, pid: record?.pid, sessionId: record?.sessionId }).toEqual({
      state: "running",
      pid: 4242,
      sessionId: "chat-1",
    });
    expect(jobs.owned()).toEqual([job]);
    expect(jobs.get(job.id)).toEqual(job);
    expect(jobs.list()).toEqual([job]);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  test("AC-8,9,19 spawn failures are chat NaxErrors and write no record", async () => {
    _jobRunnerDeps.spawn = mock(() => {
      throw new Error("boom");
    });
    const jobs = runner();
    const changed = mock(() => {});
    jobs.onChange(changed);
    const failure = jobs.start(request);
    await expect(failure).rejects.toBeInstanceOf(NaxError);
    await expect(failure).rejects.toMatchObject({
      message: expect.stringContaining("could not start nax run: boom"),
      code: "CHAT_JOB_SPAWN_FAILED",
      context: expect.objectContaining({ stage: "chat" }),
    });
    expect(await readJobRecords(outputDir)).toEqual([]);
    expect(jobs.running()).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
    expect(_jobRunnerDeps.closeLog).toHaveBeenCalledWith(73);
  });

  test("running-record failure returns an explicitly managed launch, not a retryable spawn failure", async () => {
    _jobStoreDeps.rename = mock(() => {
      throw new Error("disk full");
    });
    const jobs = runner();
    const changed = mock(() => {});
    jobs.onChange(changed);
    const job = await jobs.start({ ...request, kind: "bot_fix" });
    expect(job).toMatchObject({ state: "running", pid: child.pid });
    expect(job.note).toContain("running record could not be saved");
    expect(job.note).toContain("do not retry");
    expect(job.note).toContain("keep this chat open");
    expect(jobs.owned()).toEqual([job]);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(_jobRunnerDeps.spawn).toHaveBeenCalledTimes(1);
    expect(_jobRunnerDeps.kill).not.toHaveBeenCalled();
    expect(await readJobRecords(outputDir)).toEqual([]);

    // The exit observer must survive failure of the initial running-record write.
    _jobStoreDeps.rename = originalStoreDeps.rename;
    const ended = nextChange(jobs);
    exit(2);
    await ended;
    expect(await readJobRecords(outputDir)).toEqual([
      expect.objectContaining({ id: job.id, state: "failed", exitCode: 2, endedAt: expect.any(String) }),
    ]);
    expect(jobs.running()).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(3);
    expect(jobs.takeNotice()).toContain(`job ${job.id} (bot_fix f1) ended: failed`);
  });

  test("AC-10,11,12,13,14,16,18 owned exit uses matching real status, persists and queues notice", async () => {
    const jobs = runner();
    const changed = mock(() => {});
    jobs.onChange(changed);
    const job = await jobs.start(request);
    await Bun.write(
      join(featureDir(repoRoot, "f1"), "status.json"),
      JSON.stringify({
        version: 1,
        run: { id: "run-1", pid: job.pid, status: "completed" },
        cost: { spent: 1.2, limit: null },
        progress: { passed: 3, total: 7, failed: 1, pending: 3 },
      }),
    );
    const ended = nextChange(jobs);
    exit(0);
    await ended;
    const records = await readJobRecords(outputDir);
    expect(records[0]).toMatchObject({
      state: "succeeded",
      endedAt: new Date(clock.now()).toISOString(),
      exitCode: 0,
      cost: 1.2,
    });
    const notice = jobs.peekNotice();
    expect(notice?.startsWith(`[nax-jobs] job ${job.id} (run f1) ended: succeeded`)).toBe(true);
    expect(jobs.takeNotice()).toBe(notice);
    expect(jobs.takeNotice()).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(3);
    expect(jobs.running()).toEqual([]);
    expect(jobs.owned()).toEqual([]);
  });

  test("owner preserves cancellation durably requested by another chat", async () => {
    const jobs = runner();
    const job = await jobs.start(request);
    await Bun.write(
      join(featureDir(repoRoot, "f1"), "status.json"),
      JSON.stringify({
        version: 1,
        run: { id: "run-1", pid: job.pid, status: "completed" },
        cost: { spent: 1.2, limit: null },
        progress: { passed: 3, total: 7, failed: 0, pending: 4 },
      }),
    );
    const attached = runner();
    await attached.attach();
    await attached.cancel(job.id);
    expect((await readJobRecords(outputDir))[0]?.cancelRequested).toBe(true);
    expect(jobs.get(job.id)?.cancelRequested).toBeUndefined();
    const ended = nextChange(jobs);
    exit(0);
    await ended;
    expect((await readJobRecords(outputDir))[0]).toMatchObject({
      state: "cancelled",
      cancelRequested: true,
      exitCode: 0,
      cost: 1.2,
    });
    expect(jobs.takeNotice()).toContain("ended: cancelled");
    attached.dispose();
    jobs.dispose();
  });

  test("terminal write failure releases an exited job and retries without signalling or duplicate notices", async () => {
    const jobs = runner();
    const job = await jobs.start(request);
    _jobStoreDeps.rename = mock(() => {
      throw new Error("transient rename failure");
    });
    const ended = nextChange(jobs);
    exit(7);
    await ended;
    expect(jobs.running()).toEqual([]);
    expect(jobs.owned()).toEqual([]);
    expect(jobs.get(job.id)).toMatchObject({ state: "failed", exitCode: 7, endedAt: expect.any(String) });
    expect(jobs.get(job.id)?.note).toContain("could not be saved");
    expect(jobs.takeNotice()).toContain("could not be saved");
    await expect(jobs.cancel(job.id)).rejects.toMatchObject({ code: "CHAT_JOB_NOT_RUNNING" });
    expect(_jobRunnerDeps.kill).not.toHaveBeenCalled();
    expect((await readJobRecords(outputDir))[0]?.state).toBe("running");
    _jobStoreDeps.rename = originalStoreDeps.rename;
    const saved = nextChange(jobs);
    await clock.advance(2_000);
    await saved;
    expect((await readJobRecords(outputDir))[0]).toMatchObject({ state: "failed", exitCode: 7 });
    expect(jobs.takeNotice()).toBeUndefined();
    expect(clock.pending()).toBe(0);
    jobs.dispose();
  });

  test("immediately exited children finalize after the running write; notices stay FIFO", async () => {
    _jobRunnerDeps.spawn = mock(() => ({ ...child, exited: Promise.resolve(2) }));
    const jobs = runner();
    const firstEnd = nextTerminal(jobs);
    const first = await jobs.start({ ...request, kind: "bot_fix" });
    await firstEnd;
    const secondEnd = nextTerminal(jobs);
    const second = await jobs.start({ ...request, kind: "bot_review" });
    await secondEnd;
    expect((await readJobRecords(outputDir)).every((job) => job.state === "failed" && job.exitCode === 2)).toBe(true);
    expect(jobs.takeNotice()).toContain(first.id);
    expect(jobs.takeNotice()).toContain(second.id);
  });

  test("polling cannot overwrite a terminal outcome with a delayed initial running write", async () => {
    const release = Promise.withResolvers<void>();
    const writing = Promise.withResolvers<void>();
    spyOn(_jobStoreDeps, "write").mockImplementation(async (path, content) => {
      if (typeof path !== "string" || typeof content !== "string") throw new Error("expected a JSON record write");
      if (content.includes('"state": "running"')) {
        writing.resolve();
        await release.promise;
      }
      return originalStoreDeps.write(path, content);
    });
    const jobs = runner();
    const ended = nextTerminal(jobs);
    const starting = jobs.start({ ...request, kind: "bot_fix" });
    await writing.promise;
    exit(0);
    await child.exited;
    const rearmed = Promise.withResolvers<void>();
    _jobRunnerDeps.setTimeout = (callback, ms) => {
      rearmed.resolve();
      return clock.setTimeout(callback, ms);
    };
    try {
      await clock.advance(JOB_POLL_MS);
      // Wait until the poll either finishes or (incorrectly) finalizes before releasing the write.
      await Promise.race([rearmed.promise, ended]);
    } finally {
      release.resolve();
    }
    const job = await starting;
    await ended;
    expect(jobs.get(job.id)).toMatchObject({ state: "succeeded", exitCode: 0 });
    expect((await readJobRecords(outputDir))[0]).toMatchObject({ state: "succeeded", exitCode: 0 });
    expect(jobs.takeNotice()).toContain("ended: succeeded");
    expect(jobs.takeNotice()).toBeUndefined();
    expect(clock.pending()).toBe(0);
    jobs.dispose();
  });

  test("query results and start results are independent snapshots, sorted newest first", async () => {
    const jobs = runner();
    const first = await jobs.start(request);
    Object.assign(first.argv, { 0: "mutated" });
    expect(jobs.get(first.id)?.argv).toEqual([...request.argv, "--chat-asks", jobAsksDir(outputDir, first.id)]);
    await clock.advance(1);
    const second = await jobs.start({ ...request, kind: "bot_review" });
    expect(jobs.list().map((job) => job.id)).toEqual([second.id, first.id]);
    expect(jobs.running().map((job) => job.id)).toEqual([second.id, first.id]);
    const snapshot = jobs.get(first.id);
    if (snapshot) Object.assign(snapshot, { state: "failed" });
    expect(jobs.get(first.id)?.state).toBe("running");
    expect(jobs.get("missing")).toBeUndefined();
  });

  test("missing log is empty and dispose does not signal; unsubscribe removes listener", async () => {
    const jobs = runner();
    const changed = mock(() => {});
    const off = jobs.onChange(changed);
    off();
    const job = await jobs.start(request);
    await jobs.attach();
    expect(await jobs.logTail(job.id)).toBe("");
    jobs.dispose();
    expect(changed).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
    expect(_jobRunnerDeps.kill).not.toHaveBeenCalled();
  });
});

function nextTerminal(jobs: ReturnType<typeof runner>): Promise<void> {
  return new Promise((resolve) => {
    const off = jobs.onChange(() => {
      if (jobs.peekNotice() && jobs.list().every((job) => job.state !== "running")) {
        off();
        resolve();
      }
    });
  });
}
