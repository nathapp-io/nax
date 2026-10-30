/**
 * US-004: the jobs picker's rows, title and notes. Rows merge the chat jobs and the background
 * tasks, running first, newest first, capped; none is current and typing does not filter.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { BackgroundTask } from "@/chat/background/task-types";
import type { ChatJob, ChatJobKind, ChatJobState } from "@/chat/jobs/job-types";
import { _pickerDeps, MAX_JOB_PICKER_ROWS, type PickerModelInput, pickerModel } from "@/tui/chat/picker-model";
import { relativeTime } from "@/tui/chat/relative-time";

const NOW_MS = Date.parse("2026-05-01T12:00:00.000Z");
const MIN_MS = 60_000;

function at(minutesAgo: number): string {
  return new Date(NOW_MS - minutesAgo * MIN_MS).toISOString();
}

function job(over: Partial<ChatJob> & { id: string }): ChatJob {
  const kind: ChatJobKind = over.kind ?? "run";
  const state: ChatJobState = "running";
  return {
    schemaVersion: 1,
    kind,
    target: "f1",
    argv: [],
    cwd: "/repo",
    pid: 1,
    startedAt: at(1),
    state,
    logPath: "/repo/log",
    sessionId: "s1",
    approvedAt: at(1),
    ...over,
  };
}

function task(over: Partial<BackgroundTask> & { id: string }): BackgroundTask {
  return {
    command: "bun dev",
    origin: "agent",
    startedAt: at(1),
    state: "running",
    logPath: "/repo/task.log",
    ...over,
  };
}

function jobsModel(extra: Partial<PickerModelInput> = {}) {
  return pickerModel({
    kind: "jobs",
    models: [],
    currentModel: "",
    currentMode: "guarded",
    nowMs: NOW_MS,
    jobs: [],
    tasks: [],
    ...extra,
  });
}

describe("pickerModel jobs kind", () => {
  const originalNow = _pickerDeps.now;
  afterEach(() => {
    _pickerDeps.now = originalNow;
  });

  test("AC-1 titles the picker Jobs and tasks · enter output · ctrl+x stop", () => {
    expect(jobsModel().title).toBe("Jobs and tasks · enter output · ctrl+x stop");
    expect(jobsModel().kind).toBe("jobs");
  });

  test("AC-2 returns no entries for empty jobs and tasks", () => {
    expect(jobsModel().entries).toEqual([]);
  });

  test("AC-3 notes no jobs or tasks (muted) when empty", () => {
    expect(jobsModel().note).toEqual({ text: "no jobs or tasks", tone: "muted" });
  });

  test("AC-4 shows the supplied warning as a warning note over an empty list", () => {
    const model = jobsModel({ warning: "job is not owned by this chat" });
    expect(model.note).toEqual({ text: "job is not owned by this chat", tone: "warning" });
  });

  test("a warning also shows over a non-empty list, and rows carry no note otherwise", () => {
    const jobs = [job({ id: "run-0000aaaa" })];
    expect(jobsModel({ jobs, warning: "w" }).note).toEqual({ text: "w", tone: "warning" });
    expect(jobsModel({ jobs }).note).toBeUndefined();
  });

  test("absent jobs and tasks inputs are treated as empty", () => {
    const model = pickerModel({ kind: "jobs", models: [], currentModel: "", currentMode: "guarded" });
    expect(model.entries).toEqual([]);
    expect(model.note).toEqual({ text: "no jobs or tasks", tone: "muted" });
  });

  test("AC-5 a running task becomes a bash row", () => {
    const tasks = [task({ id: "bash-1a2b3c4d", command: "bun run test" })];
    const [entry] = jobsModel({ tasks }).entries;
    expect(entry?.value).toBe("bash-1a2b3c4d");
    expect(entry?.label).toBe("bash bun run test");
    expect(entry?.detail?.startsWith("running · ")).toBe(true);
  });

  test("a multi-line task command is shown on one row", () => {
    const [entry] = jobsModel({ tasks: [task({ id: "bash-0000aaaa", command: "echo a\necho b" })] }).entries;
    expect(entry?.label).not.toContain("\n");
  });

  test("AC-6 a run job's label is its kind and target", () => {
    const jobs = [job({ id: "run-0000aaaa", target: "f1", progress: { passed: 3, total: 7 }, cost: 1.2 })];
    const [entry] = jobsModel({ jobs }).entries;
    expect(entry?.value).toBe("run-0000aaaa");
    expect(entry?.label).toBe("run f1");
  });

  test("AC-7 progress and cost end the detail, each with its leading separator", () => {
    const jobs = [job({ id: "run-0000aaaa", target: "f1", progress: { passed: 3, total: 7 }, cost: 1.2 })];
    const [entry] = jobsModel({ jobs }).entries;
    expect(entry?.detail?.endsWith(" · 3/7 · $1.20")).toBe(true);
    expect(entry?.detail).toBe(`running · ${relativeTime(jobs[0]?.startedAt, NOW_MS)} · 3/7 · $1.20`);
  });

  test("a job without progress or cost has neither segment", () => {
    const [entry] = jobsModel({ jobs: [job({ id: "run-0000aaaa", state: "failed" })] }).entries;
    expect(entry?.detail).toBe(`failed · ${relativeTime(at(1), NOW_MS)}`);
  });

  test("a zero cost still ends the detail with the dollar amount", () => {
    const [entry] = jobsModel({ jobs: [job({ id: "run-0000aaaa", cost: 0 })] }).entries;
    expect(entry?.detail?.endsWith(" · $0.00")).toBe(true);
  });

  test.each(["bot_review", "bot_fix"] as const)("AC-8 a %s job's target is prefixed with #", (kind) => {
    const [entry] = jobsModel({ jobs: [job({ id: `${kind}-0000aaaa`, kind, target: "42" })] }).entries;
    expect(entry?.label).toBe(`${kind} #42`);
  });

  test("AC-9 the detail's time part is relativeTime(startedAt, nowMs)", () => {
    const startedAt = at(125);
    const [entry] = jobsModel({ jobs: [job({ id: "plan-0000aaaa", kind: "plan", startedAt })] }).entries;
    expect(relativeTime(startedAt, NOW_MS)).toBe("2 h ago");
    expect(entry?.detail).toBe("running · 2 h ago");
  });

  test("the detail omits the time part and its separator when relativeTime is empty", () => {
    const [entry] = jobsModel({
      jobs: [job({ id: "run-0000aaaa", startedAt: "not a date", progress: { passed: 1, total: 2 } })],
    }).entries;
    expect(entry?.detail).toBe("running · 1/2");
    const [bare] = jobsModel({ tasks: [task({ id: "bash-0000aaaa", startedAt: "not a date" })] }).entries;
    expect(bare?.detail).toBe("running");
  });

  test("AC-9 reads the clock from _pickerDeps.now when nowMs is absent", () => {
    _pickerDeps.now = () => NOW_MS;
    const model = pickerModel({
      kind: "jobs",
      models: [],
      currentModel: "",
      currentMode: "guarded",
      tasks: [task({ id: "bash-0000aaaa", startedAt: at(5) })],
    });
    expect(model.entries[0]?.detail).toBe("running · 5 min ago");
  });

  test("AC-10 a running task started earlier than an ended job is listed first", () => {
    const jobs = [job({ id: "run-0000aaaa", state: "succeeded", startedAt: at(1) })];
    const tasks = [task({ id: "bash-0000aaaa", startedAt: at(500) })];
    expect(jobsModel({ jobs, tasks }).entries.map((e) => e.value)).toEqual(["bash-0000aaaa", "run-0000aaaa"]);
  });

  test("AC-11 each group orders jobs and tasks together, newest startedAt first", () => {
    const jobs = [
      job({ id: "run-0000aaa1", startedAt: at(30) }),
      job({ id: "run-0000aaa2", startedAt: at(10), state: "failed" }),
      job({ id: "run-0000aaa3", startedAt: at(50), state: "cancelled" }),
    ];
    const tasks = [
      task({ id: "bash-0000bbb1", startedAt: at(20) }),
      task({ id: "bash-0000bbb2", startedAt: at(40), state: "stopped" }),
      task({ id: "bash-0000bbb3", startedAt: at(5), state: "succeeded" }),
    ];
    expect(jobsModel({ jobs, tasks }).entries.map((e) => e.value)).toEqual([
      "bash-0000bbb1",
      "run-0000aaa1",
      "bash-0000bbb3",
      "run-0000aaa2",
      "bash-0000bbb2",
      "run-0000aaa3",
    ]);
  });

  test("AC-12 equal startedAt orders by value ascending", () => {
    const startedAt = at(3);
    const jobs = [job({ id: "run-0000cccc", startedAt }), job({ id: "run-0000aaaa", startedAt })];
    const tasks = [task({ id: "bash-0000bbbb", startedAt })];
    expect(jobsModel({ jobs, tasks }).entries.map((e) => e.value)).toEqual([
      "bash-0000bbbb",
      "run-0000aaaa",
      "run-0000cccc",
    ]);
  });

  test("AC-13 caps rows at MAX_JOB_PICKER_ROWS, keeping the newest", () => {
    const jobs = Array.from({ length: 15 }, (_, i) =>
      job({ id: `run-${i.toString(16).padStart(8, "0")}`, startedAt: at(i + 1) }),
    );
    const tasks = Array.from({ length: 10 }, (_, i) =>
      task({ id: `bash-${i.toString(16).padStart(8, "0")}`, startedAt: at(100 + i) }),
    );
    const entries = jobsModel({ jobs, tasks }).entries;
    expect(MAX_JOB_PICKER_ROWS).toBe(20);
    expect(entries).toHaveLength(20);
    expect(entries[0]?.value).toBe("run-00000000");
    expect(entries[19]?.value).toBe("bash-00000004");
  });

  test("AC-14 marks no row current", () => {
    const jobs = [job({ id: "run-0000aaaa" })];
    const tasks = [task({ id: "bash-0000aaaa" })];
    const entries = jobsModel({ jobs, tasks }).entries;
    expect(entries).toHaveLength(2);
    for (const entry of entries) expect(entry.current).not.toBe(true);
  });

  test("typing does not filter the rows", () => {
    const jobs = [job({ id: "run-0000aaaa" })];
    expect(jobsModel({ jobs, query: "zzz" }).entries).toHaveLength(1);
  });
});

describe("pickerModel existing kinds with jobs and tasks supplied", () => {
  const base = {
    models: ["openai/gpt-6", "anthropic/claude-x"],
    currentModel: "openai/gpt-6",
    currentMode: "guarded" as const,
    nowMs: NOW_MS,
    sessions: [{ sessionId: "s1", title: "first", updatedAt: at(10) }],
  };
  const extras = { jobs: [job({ id: "run-0000aaaa" })], tasks: [task({ id: "bash-0000aaaa" })] };

  test.each(["model", "mode", "effort", "resume"] as const)("AC-15 %s kind is unchanged", (kind) => {
    const plain = pickerModel({ ...base, kind });
    expect(plain.entries.length).toBeGreaterThan(0);
    expect(pickerModel({ ...base, ...extras, kind })).toEqual(plain);
  });
});
