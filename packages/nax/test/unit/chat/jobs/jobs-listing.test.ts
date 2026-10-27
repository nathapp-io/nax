import { describe, expect, test } from "bun:test";
import type { ChatJob } from "@/chat/jobs/job-types";

const RUN: ChatJob = {
  schemaVersion: 1,
  id: "run-1a2b3c4d",
  kind: "run",
  target: "f1",
  argv: [],
  cwd: "/r",
  pid: 123,
  startedAt: "2026-10-27T10:00:00Z",
  state: "running",
  logPath: "/o/job.log",
  sessionId: "chat",
  approvedAt: "2026-10-27T09:59:00Z",
};

describe("formatJobsListing", () => {
  test("AC-12 returns (no jobs) for an empty list", async () => {
    const { formatJobsListing } = await import("@/chat/jobs/jobs-listing");
    expect(formatJobsListing([])).toBe("(no jobs)");
  });
  test("AC-13 formats progress, cost and timestamp exactly", async () => {
    const { formatJobsListing } = await import("@/chat/jobs/jobs-listing");
    expect(formatJobsListing([{ ...RUN, progress: { passed: 3, total: 7 }, cost: 1.2 }])).toBe(
      "run-1a2b3c4d  running  run f1  3/7  $1.20  2026-10-27T10:00:00Z",
    );
  });
  test("AC-14 formats a failed bot_fix target as a PR", async () => {
    const { formatJobsListing } = await import("@/chat/jobs/jobs-listing");
    expect(
      formatJobsListing([{ ...RUN, id: "bot_fix-11111111", kind: "bot_fix", state: "failed", target: "12" }]),
    ).toBe("bot_fix-11111111  failed  bot_fix #12  2026-10-27T10:00:00Z");
  });
  test("AC-15 lists only the newest 20 jobs and counts the remainder without mutating input", async () => {
    const { formatJobsListing } = await import("@/chat/jobs/jobs-listing");
    const jobs = Object.freeze(
      Array.from({ length: 23 }, (_, index) => ({
        ...RUN,
        id: `run-${index.toString(16).padStart(8, "0")}`,
        startedAt: `2026-10-${String(index + 1).padStart(2, "0")}T10:00:00Z`,
      })),
    );
    const lines = formatJobsListing(jobs).split("\n");
    expect(lines).toHaveLength(21);
    expect(lines.slice(0, 20)).toEqual(
      [...jobs]
        .reverse()
        .slice(0, 20)
        .map((job) => `${job.id}  running  run f1  ${job.startedAt}`),
    );
    expect(lines[20]).toBe("+3 more");
    expect(jobs[0]?.id).toBe("run-00000000");
  });
  test("includes zero-valued metrics, bot_review PRs and no overflow at 20", async () => {
    const { formatJobsListing } = await import("@/chat/jobs/jobs-listing");
    const job: ChatJob = { ...RUN, kind: "bot_review", target: "9", cost: 0, progress: { passed: 0, total: 0 } };
    expect(formatJobsListing([job])).toBe("run-1a2b3c4d  running  bot_review #9  0/0  $0.00  2026-10-27T10:00:00Z");
    expect(formatJobsListing(Array.from({ length: 20 }, () => RUN)).split("\n")).toHaveLength(20);
  });
});
