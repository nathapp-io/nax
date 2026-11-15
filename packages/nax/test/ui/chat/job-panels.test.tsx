import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeFakeClock, mountChatPicker } from "@test/helpers";
import { cleanup, render } from "ink-testing-library";
import { act, useState } from "react";
import type { JobPanelView } from "@/chat";
import { type ChatHost, type ChatHostState, type ChatJob, type ChatJobs, createChatAskController } from "@/chat";
import type { TranscriptEntry } from "@/tui/chat/transcript-model";
import { _jobPanelsDeps, JOB_PANEL_REFRESH_MS, useJobPanels } from "@/tui/chat/use-job-panels";

/** The deps as shipped, restored after every case so one case's stubs never leak. */
const REAL_DEPS = { ..._jobPanelsDeps };

/** A read `readJobPanelView` has been asked for and the case has not settled yet. */
interface PendingRead {
  readonly job: ChatJob;
  resolve(view: JobPanelView): void;
}

let reads: PendingRead[] = [];

beforeEach(() => {
  reads = [];
  _jobPanelsDeps.readJobPanelView = (job) =>
    new Promise<JobPanelView>((resolve) => {
      reads.push({ job, resolve });
    });
});

afterEach(() => {
  Object.assign(_jobPanelsDeps, REAL_DEPS);
  cleanup();
});

/** Swaps the hook's timer and clock for a fake one, so no case sleeps. */
function withFakeClock() {
  const clock = makeFakeClock();
  _jobPanelsDeps.setTimeout = clock.setTimeout;
  _jobPanelsDeps.clearTimeout = (handle) => {
    if (typeof handle === "number") clock.clearTimeout(handle);
  };
  _jobPanelsDeps.now = () => new Date(clock.now());
  return clock;
}

/** A `run` job of `review-and-gate-guards`, running unless a case says otherwise. */
function job(overrides: Partial<ChatJob> = {}): ChatJob {
  return {
    schemaVersion: 1,
    id: "run-1",
    kind: "run",
    target: "review-and-gate-guards",
    argv: ["nax", "run", "review-and-gate-guards"],
    cwd: "/repo",
    pid: 4_242,
    startedAt: new Date(0).toISOString(),
    state: "running",
    logPath: "/repo/chat-jobs/run-1.log",
    sessionId: "session-1",
    approvedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

interface FakeJobs {
  readonly jobs: ChatJobs;
  /** Records the job as the registry would, without announcing it. */
  set(next: ChatJob): void;
  /** Annonces every change the way the runner does. */
  emit(): void;
  /** How many listeners the hook still has registered. */
  listeners(): number;
}

function fakeJobs(initial: readonly ChatJob[] = []): FakeJobs {
  const records = new Map(initial.map((entry) => [entry.id, entry]));
  const listeners = new Set<() => void>();
  const jobs: ChatJobs = {
    start: async () => {
      throw new Error("fake jobs cannot start");
    },
    list: () => [...records.values()],
    get: (id) => records.get(id),
    running: () => [...records.values()].filter((entry) => entry.state === "running"),
    owned: () => [],
    cancel: async () => {
      throw new Error("fake jobs cannot cancel");
    },
    canCancel: async () => ({ ok: true }),
    attach: async () => {},
    logTail: async () => "",
    peekNotice: () => undefined,
    takeNotice: () => undefined,
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {},
  };
  return {
    jobs,
    set: (next) => {
      records.set(next.id, next);
    },
    emit: () => {
      for (const listener of [...listeners]) listener();
    },
    listeners: () => listeners.size,
  };
}

const STATE: ChatHostState = {
  sessionId: "session-1",
  mode: "guarded",
  model: "test-model",
  meta: {
    schemaVersion: 1,
    sessionId: "session-1",
    cwd: "/repo",
    mode: "ask",
    model: "test-model",
    bashApproval: "gated",
    title: null,
    createdAt: "now",
    updatedAt: null,
    costUsd: 0,
  },
};

/** A typed host over the given registry; none leaves `host.jobs` absent. */
function hostWith(jobs?: ChatJobs): ChatHost {
  return {
    repoRoot: "/repo",
    models: [STATE.model],
    asks: createChatAskController({ mode: "guarded", answer: () => {} }),
    ...(jobs === undefined ? {} : { jobs }),
    current: () => STATE,
    notice: () => undefined,
    send: async () => {},
    cancel: () => {},
    start: async () => {},
    close: async () => {},
    clear: async () => {},
    resume: async () => {},
    switchTo: async () => {},
    listSessions: async () => [],
  };
}

/** The view a settled read applies: the job as it stood when the refresh started, plus overrides. */
function viewOf(job: ChatJob, overrides: Partial<JobPanelView> = {}): JobPanelView {
  return {
    jobId: job.id,
    kind: job.kind,
    target: job.target,
    state: job.state,
    elapsedMs: 0,
    stories: [],
    decisions: [],
    logTail: [],
    ...overrides,
  };
}

/** The next read the hook asked for; a case that expected one fails loudly here. */
function nextRead(): PendingRead {
  const read = reads.shift();
  if (read === undefined) throw new Error("the hook started no job panel read");
  return read;
}

/** Runs `action` inside an act; the resolved promise is what a case awaits. */
function actFrame(action: () => void): Promise<void> {
  return Promise.resolve(
    act(async () => {
      action();
    }),
  );
}

/** Runs an async `action` inside an act, waiting for what it settles. */
function actAsyncFrame(action: () => Promise<void>): Promise<void> {
  return Promise.resolve(
    act(async () => {
      await action();
    }),
  );
}

/** One turn of the microtask queue, inside an act, so a continuation's state is drawn. */
const flushFrame = (): Promise<void> => actFrame(() => {});

/** Resolves the pending read inside an act, so the frame after it is the one it produced. */
async function settleRead(jobs: FakeJobs, id = "run-1", overrides: Partial<JobPanelView> = {}): Promise<void> {
  const read = nextRead();
  const latest = jobs.jobs.get(id) ?? read.job;
  await actFrame(() => {
    read.resolve(viewOf(latest, overrides));
  });
  await flushFrame();
}

const PANELS_INITIAL: readonly TranscriptEntry[] = [];

interface Panels {
  /** The transcript the hook has produced, as the last render saw it. */
  entries(): readonly TranscriptEntry[];
  /** How many times the hook called `setEntries`. */
  calls(): number;
  setTurnRunning(value: boolean): Promise<void>;
  /** Replaces the transcript wholesale, as `/clear` or a resume does. */
  replace(next: readonly TranscriptEntry[]): Promise<void>;
  unmount(): void;
}

/** Mounts the hook over the host with a real `useState` transcript. */
function mountPanels(host: ChatHost, initialTurnRunning = false): Panels {
  let calls = 0;
  let rows: readonly TranscriptEntry[] = PANELS_INITIAL;
  const setters: {
    turnRunning?: (value: boolean) => void;
    rows?: (
      next: readonly TranscriptEntry[] | ((current: readonly TranscriptEntry[]) => readonly TranscriptEntry[]),
    ) => void;
  } = {};
  function Root(): null {
    const [turnRunning, setTurnRunning] = useState(initialTurnRunning);
    const [entries, setEntries] = useState<readonly TranscriptEntry[]>(PANELS_INITIAL);
    setters.turnRunning = setTurnRunning;
    setters.rows = setEntries;
    rows = entries;
    useJobPanels({
      host,
      setEntries: (update) => {
        calls += 1;
        setEntries(update);
      },
      turnRunning,
    });
    return null;
  }
  const ui = render(<Root />);
  return {
    entries: () => rows,
    calls: () => calls,
    setTurnRunning: async (value) => {
      await actFrame(() => {
        setters.turnRunning?.(value);
      });
    },
    replace: async (next) => {
      await actFrame(() => {
        setters.rows?.(next);
      });
    },
    unmount: () => ui.unmount(),
  };
}

/** The job ids the transcript holds panels for, in transcript order. */
function panelIds(entries: readonly TranscriptEntry[]): string[] {
  return entries.flatMap((entry) => (entry.kind === "job" ? [entry.view.jobId] : []));
}

/** The view of one job's panel, or undefined when the transcript holds none. */
function panelView(entries: readonly TranscriptEntry[], jobId: string): JobPanelView | undefined {
  const entry = entries.find((row) => row.kind === "job" && row.view.jobId === jobId);
  return entry?.kind === "job" ? entry.view : undefined;
}

/** One refresh cadence, on the fake clock, inside an act. */
async function tick(clock: ReturnType<typeof makeFakeClock>, ms = JOB_PANEL_REFRESH_MS): Promise<void> {
  await actAsyncFrame(() => clock.advance(ms));
}

describe("useJobPanels: appending a panel", () => {
  test("AC-8 appends a panel for a newly running job when no turn runs", async () => {
    const clock = withFakeClock();
    const fake = fakeJobs();
    const panels = mountPanels(hostWith(fake.jobs));
    fake.set(job());
    await actFrame(() => {
      fake.emit();
    });
    expect(reads).toHaveLength(1);
    await settleRead(fake);
    expect(panelIds(panels.entries())).toEqual(["run-1"]);
    expect(panels.calls()).toBe(1);
    // Nothing is left armed for a case that does not step the clock.
    expect(clock.pending()).toBe(1);
  });

  test("AC-13 panels a job that was already running when the hook mounted", async () => {
    withFakeClock();
    const fake = fakeJobs([job()]);
    const panels = mountPanels(hostWith(fake.jobs));
    expect(reads).toHaveLength(1);
    await settleRead(fake);
    expect(panelIds(panels.entries())).toEqual(["run-1"]);
  });

  test("AC-14 adds no panel for a job that had already ended when the hook mounted", async () => {
    withFakeClock();
    const fake = fakeJobs([job({ state: "succeeded", endedAt: new Date(1_000).toISOString() })]);
    const panels = mountPanels(hostWith(fake.jobs));
    expect(reads).toHaveLength(0);
    await Promise.resolve();
    expect(panels.entries()).toEqual([]);
    expect(panels.calls()).toBe(0);
  });

  test("AC-15 never calls setEntries when the host exposes no job registry", async () => {
    const clock = withFakeClock();
    const panels = mountPanels(hostWith());
    await tick(clock);
    expect(panels.calls()).toBe(0);
    expect(panels.entries()).toEqual([]);
    expect(clock.pending()).toBe(0);
  });

  test("AC-19 appends the panel again after the transcript is replaced", async () => {
    const clock = withFakeClock();
    const fake = fakeJobs([job()]);
    const panels = mountPanels(hostWith(fake.jobs));
    await settleRead(fake);
    expect(panelIds(panels.entries())).toEqual(["run-1"]);
    await panels.replace([{ kind: "user", text: "a cleared transcript" }]);
    expect(panelIds(panels.entries())).toEqual([]);
    await tick(clock);
    expect(reads).toHaveLength(1);
    await settleRead(fake);
    expect(panels.entries()).toHaveLength(2);
    expect(panelIds(panels.entries())).toEqual(["run-1"]);
  });
});

describe("useJobPanels: a running turn", () => {
  test("AC-9 holds the panel back for the whole turn, across refresh ticks", async () => {
    const clock = withFakeClock();
    const fake = fakeJobs();
    const panels = mountPanels(hostWith(fake.jobs), true);
    fake.set(job());
    await actFrame(() => {
      fake.emit();
    });
    await settleRead(fake);
    expect(panelIds(panels.entries())).toEqual([]);
    await tick(clock);
    await settleRead(fake);
    expect(panelIds(panels.entries())).toEqual([]);
  });

  test("AC-10 the turn's end appends the panel of a job that started during it", async () => {
    const clock = withFakeClock();
    const fake = fakeJobs();
    const panels = mountPanels(hostWith(fake.jobs), true);
    fake.set(job());
    await actFrame(() => {
      fake.emit();
    });
    await settleRead(fake);
    expect(panelIds(panels.entries())).toEqual([]);
    await panels.setTurnRunning(false);
    expect(reads).toHaveLength(1);
    await settleRead(fake);
    expect(panelIds(panels.entries())).toEqual(["run-1"]);
    expect(clock.pending()).toBe(1);
  });

  test("AC-11 a job that started and ended during the turn appears with its ended state afterwards", async () => {
    withFakeClock();
    const fake = fakeJobs();
    const panels = mountPanels(hostWith(fake.jobs), true);
    fake.set(job());
    await actFrame(() => {
      fake.emit();
    });
    await settleRead(fake);
    fake.set(job({ state: "succeeded", endedAt: new Date(5_000).toISOString() }));
    await actFrame(() => {
      fake.emit();
    });
    await settleRead(fake);
    expect(panelIds(panels.entries())).toEqual([]);
    await panels.setTurnRunning(false);
    await settleRead(fake);
    expect(panelIds(panels.entries())).toEqual(["run-1"]);
    expect(panelView(panels.entries(), "run-1")?.state).toBe("succeeded");
  });
});

describe("useJobPanels: refreshing a panel", () => {
  test("AC-16 refreshes a running job again after JOB_PANEL_REFRESH_MS with no change event", async () => {
    const clock = withFakeClock();
    const fake = fakeJobs([job()]);
    const panels = mountPanels(hostWith(fake.jobs));
    await settleRead(fake);
    expect(panelView(panels.entries(), "run-1")?.cost).toBeUndefined();
    await tick(clock);
    expect(reads).toHaveLength(1);
    await settleRead(fake, "run-1", { cost: 3.18 });
    expect(panelView(panels.entries(), "run-1")?.cost).toBe(3.18);
    expect(panelIds(panels.entries())).toEqual(["run-1"]);
  });

  test("AC-17 refreshes an ended job once and stops on the next tick", async () => {
    const clock = withFakeClock();
    const fake = fakeJobs([job()]);
    const panels = mountPanels(hostWith(fake.jobs));
    await settleRead(fake);
    fake.set(job({ state: "succeeded", endedAt: new Date(5_000).toISOString() }));
    await actFrame(() => {
      fake.emit();
    });
    expect(reads).toHaveLength(1);
    await settleRead(fake);
    expect(panelView(panels.entries(), "run-1")?.state).toBe("succeeded");
    await tick(clock);
    expect(reads).toHaveLength(0);
    expect(panelView(panels.entries(), "run-1")?.state).toBe("succeeded");
  });

  test("AC-18 a read that resolves after the job ended is followed by the ended state", async () => {
    withFakeClock();
    const fake = fakeJobs([job()]);
    const panels = mountPanels(hostWith(fake.jobs));
    // The read was started while the job was running; the job ends before it resolves.
    const stale = nextRead();
    fake.set(job({ state: "failed", endedAt: new Date(9_000).toISOString() }));
    await actFrame(() => {
      stale.resolve(viewOf(stale.job, { elapsedMs: 1_000 }));
    });
    await flushFrame();
    expect(panelView(panels.entries(), "run-1")?.state).toBe("running");
    // The hook owes the job exactly one more refresh, and it is the last one applied.
    const final = nextRead();
    expect(final.job.state).toBe("failed");
    await actFrame(() => {
      final.resolve(viewOf(final.job, { elapsedMs: 9_000 }));
    });
    await flushFrame();
    expect(panelView(panels.entries(), "run-1")?.state).toBe("failed");
    expect(panelView(panels.entries(), "run-1")?.elapsedMs).toBe(9_000);
    expect(reads).toHaveLength(0);
  });
});

describe("useJobPanels: disposal", () => {
  test("AC-20 removes its onChange listener on unmount", async () => {
    withFakeClock();
    const fake = fakeJobs([job()]);
    const panels = mountPanels(hostWith(fake.jobs));
    expect(fake.listeners()).toBe(1);
    await settleRead(fake);
    panels.unmount();
    expect(fake.listeners()).toBe(0);
  });

  test("AC-21 clears its refresh timer on unmount, so no refresh runs after it", async () => {
    const clock = withFakeClock();
    const fake = fakeJobs([job()]);
    const panels = mountPanels(hostWith(fake.jobs));
    await settleRead(fake);
    expect(clock.pending()).toBe(1);
    panels.unmount();
    expect(clock.pending()).toBe(0);
    await tick(clock);
    expect(reads).toHaveLength(0);
  });

  test("a read that resolves after unmount applies nothing", async () => {
    withFakeClock();
    const fake = fakeJobs([job()]);
    const panels = mountPanels(hostWith(fake.jobs));
    const pending = nextRead();
    panels.unmount();
    await actFrame(() => {
      pending.resolve(viewOf(pending.job));
    });
    expect(panels.entries()).toEqual([]);
  });
});

describe("ChatApp job panels", () => {
  test("AC-22 draws a running job's panel in the transcript", async () => {
    withFakeClock();
    const fake = fakeJobs([job()]);
    const ui = mountChatPicker({ jobs: fake.jobs });
    expect(ui.rows().some((row) => row.includes("nax run review-and-gate-guards  running"))).toBe(false);
    await settleRead(fake);
    await ui.settle();
    expect(ui.rows().some((row) => row.includes("nax run review-and-gate-guards  running"))).toBe(true);
  });
});
