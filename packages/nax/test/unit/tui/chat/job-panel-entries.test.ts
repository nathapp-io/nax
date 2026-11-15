import { describe, expect, test } from "bun:test";
import type { JobPanelView } from "@/chat";
import { hasJobPanel, upsertJobPanel } from "@/tui/chat/job-panel-entries";
import type { TranscriptEntry } from "@/tui/chat/transcript-model";

type JobEntry = Extract<TranscriptEntry, { kind: "job" }>;

/** The job entry at `index`, narrowed: a case that expected one fails loudly here. */
function panelAt(entries: readonly TranscriptEntry[], index = 0): JobEntry {
  const entry = entries[index];
  if (entry?.kind !== "job") throw new Error(`no job entry at index ${index}`);
  return entry;
}

/** A running `run` job's view, as `buildJobPanelView` projects one. */
function view(overrides: Partial<JobPanelView> = {}): JobPanelView {
  return {
    jobId: "run-1",
    kind: "run",
    target: "review-and-gate-guards",
    state: "running",
    elapsedMs: 2_520_000,
    stories: [],
    decisions: [],
    logTail: [],
    ...overrides,
  };
}

const user: TranscriptEntry = { kind: "user", text: "run it" };
const notice: TranscriptEntry = { kind: "notice", text: "the job ended" };
const panel: JobEntry = { kind: "job", view: view() };

describe("upsertJobPanel", () => {
  test("AC-1 appends a job entry when the transcript has no panel for run-1", () => {
    const next = upsertJobPanel([user], view());
    expect(next).toHaveLength(2);
    expect(next[0]).toBe(user);
    expect(panelAt(next, 1).view).toEqual(view());
  });

  test("AC-1 appends to an empty transcript", () => {
    expect(upsertJobPanel([], view())).toEqual([{ kind: "job", view: view() }]);
  });

  test("AC-2 replaces an existing panel for run-1 at its own index", () => {
    const stale: JobEntry = { kind: "job", view: view({ state: "running", elapsedMs: 1000 }) };
    const next = upsertJobPanel([user, stale, notice], view({ state: "succeeded", elapsedMs: 5000 }));
    expect(next).toHaveLength(3);
    expect(panelAt(next, 1).view).toEqual(view({ state: "succeeded", elapsedMs: 5000 }));
    // Nothing else moved or changed identity.
    expect(next[0]).toBe(user);
    expect(next[2]).toBe(notice);
  });

  test("AC-3 keeps the replaced entry's open flag", () => {
    const opened: JobEntry = { kind: "job", view: view(), open: true };
    const next = upsertJobPanel([opened], view({ cost: 3.18 }));
    expect(panelAt(next).open).toBe(true);
    expect(panelAt(next).view.cost).toBe(3.18);
  });

  test("AC-3 leaves a panel that was never opened without an open flag", () => {
    const next = upsertJobPanel([panel], view({ state: "succeeded" }));
    expect(panelAt(next).open).toBeUndefined();
  });

  test("AC-4 leaves its input array unchanged and returns a new one", () => {
    const entries: readonly TranscriptEntry[] = [user, panel, notice];
    const snapshot = structuredClone(entries);
    const next = upsertJobPanel(entries, view({ state: "failed" }));
    expect(next).not.toBe(entries);
    expect(entries).toEqual(snapshot);
    expect(entries).toHaveLength(3);
    expect(entries[1]).toBe(panel);
  });

  test("AC-4 leaves its input unchanged on the appending path too", () => {
    const entries: readonly TranscriptEntry[] = [user];
    const next = upsertJobPanel(entries, view());
    expect(next).not.toBe(entries);
    expect(entries).toEqual([user]);
  });

  test("replaces only the panel of the job the view names", () => {
    const other: JobEntry = { kind: "job", view: view({ jobId: "run-2" }) };
    const next = upsertJobPanel([panel, other], view({ elapsedMs: 42_000 }));
    expect(panelAt(next, 0).view.elapsedMs).toBe(42_000);
    expect(next[1]).toBe(other);
  });
});

describe("hasJobPanel", () => {
  test("AC-12 reports run-1 present and run-2 absent", () => {
    const entries: readonly TranscriptEntry[] = [user, panel];
    expect(hasJobPanel(entries, "run-1")).toBe(true);
    expect(hasJobPanel(entries, "run-2")).toBe(false);
  });

  test("reports nothing on an empty transcript", () => {
    expect(hasJobPanel([], "run-1")).toBe(false);
  });
});
