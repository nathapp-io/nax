/**
 * Live job panels (chat-job-panel US-003): keeps a running job's panel in the transcript.
 *
 * A job the chat started, or one it re-attached when the chat opened, becomes *paneled* the
 * first time it is seen running. A paneled job is refreshed whenever the job registry
 * announces a change and — while it still runs — on a fixed cadence, so elapsed time, cost,
 * story progress and the log tail follow the job without an event per figure. A job already
 * ended the first time it is seen is never paneled: nobody watched it, and a finished panel
 * says nothing the notice does not.
 *
 * While a turn is running the reply is still streaming, and an entry appended after it would
 * split it. So the decision to append is taken inside the `setEntries` updater, against the
 * entries as they stand (`hasJobPanel`): a job with no entry yet is held back, and one that
 * already has a panel is replaced in place, wherever the reply has got to. On the turn's
 * true-to-false edge one refresh runs for every paneled job whose panel is not in the
 * transcript yet, which is what shows a job that started — or ended — during the turn.
 *
 * Refreshes are serialized per job, and a job that has ended gets exactly one more applied
 * refresh once the one in flight settles, so its panel freezes on the final state rather
 * than on a figure read while it was still running. After that the job is not refreshed
 * again — a change announced while that last read was in flight is dropped, not queued, so
 * nothing overwrites the panel that froze. The panel is display only: nothing it reads
 * reaches the agent's context.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { useEffect, useRef } from "react";
import { type ChatHost, type ChatJob, type ChatJobs, type JobPanelView, readJobPanelView } from "@/chat";
import { getLogger } from "@/logger";
import { hasJobPanel, upsertJobPanel } from "./job-panel-entries";
import type { TranscriptEntry } from "./transcript-model";

/** How long a running job's panel is left alone between refreshes. */
export const JOB_PANEL_REFRESH_MS = 2000;

/** An armed timer's opaque handle: the runtime's here, the fake clock's in a test. */
type TimerHandle = ReturnType<typeof setTimeout> | number;

type SetEntries = (update: (rows: readonly TranscriptEntry[]) => readonly TranscriptEntry[]) => void;

export interface UseJobPanelsInput {
  readonly host: ChatHost;
  /** The transcript as the last render drew it: the only ground truth for panel membership. */
  readonly entries: readonly TranscriptEntry[];
  readonly setEntries: SetEntries;
  readonly turnRunning: boolean;
}

/**
 * Injected seams: the artifact read, the clock the panel's elapsed time is measured against,
 * and the refresh timer, which a test drives from a fake clock instead of the wall clock.
 */
export const _jobPanelsDeps: {
  readJobPanelView: (job: ChatJob, jobs: Pick<ChatJobs, "logTail">, now: Date) => Promise<JobPanelView>;
  now: () => Date;
  setTimeout: (callback: () => void, ms: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
} = {
  readJobPanelView,
  now: () => new Date(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

/** What one mounted hook knows about the job registry it is watching. */
interface PanelContext {
  readonly jobs: ChatJobs;
  readonly setEntries: SetEntries;
  /** The turn's state as it stands now, not as the last render saw it. */
  readonly turnRunning: () => boolean;
  /** The transcript as the last render drew it, so a replaced list is seen as it now stands. */
  readonly entries: () => readonly TranscriptEntry[];
}

/** The hook's own bookkeeping: which jobs it shows, and what each refresh is still owed. */
interface PanelState {
  /** Jobs the hook shows, whether or not their panel is in the transcript right now. */
  readonly paneled: Set<string>;
  /**
   * Paneled jobs whose panel the last applied update put in the transcript. Cleared again when
   * an update is refused, so it tracks the entries rather than the hook's intentions.
   */
  readonly appended: Set<string>;
  /** Jobs with a refresh pending right now. */
  readonly inFlight: Set<string>;
  /** Jobs asked for another refresh while theirs was pending. */
  readonly queued: Set<string>;
  /** Jobs whose post-end refresh has been asked for, so only one is ever pending. */
  readonly finalRequested: Set<string>;
  /** Jobs showing their ended state, which no later refresh is applied to. */
  readonly done: Set<string>;
  timer: TimerHandle | undefined;
  /** False once the hook is disposed, so a late continuation applies nothing. */
  live: boolean;
}

function newState(): PanelState {
  return {
    paneled: new Set(),
    appended: new Set(),
    inFlight: new Set(),
    queued: new Set(),
    finalRequested: new Set(),
    done: new Set(),
    timer: undefined,
    live: false,
  };
}

function clearTimer(state: PanelState): void {
  if (state.timer === undefined) return;
  _jobPanelsDeps.clearTimeout(state.timer);
  state.timer = undefined;
}

/**
 * Applies one job's view, unless a turn is running and the transcript has no panel for it yet.
 *
 * Whether the panel is in the transcript is asked of the entries as the last render drew them
 * (`hasJobPanel`), not of `appended`: `/clear` and a resume replace the entry list without
 * telling the hook, so a set kept beside them would claim a panel the transcript no longer
 * holds — and a job wrongly marked `done` is one the turn-end flush skips, which loses the
 * panel for good. So a held-back view *removes* the job from `appended` (nothing was added) and
 * never marks it done, leaving it for the flush on the turn's end. `done` is set only for a
 * view that reaches the transcript, which is also why a job ended mid-turn still appears: its
 * terminal view was held, so the flush still owes it one refresh.
 *
 * The updater repeats the check as the final authority — the turn can start between here and
 * the render — and reconciles both sets when it refuses, so bookkeeping taken here can never
 * outlive a refusal.
 */
function applyView(context: PanelContext, state: PanelState, jobId: string, view: JobPanelView): void {
  if (context.turnRunning() && !hasJobPanel(context.entries(), jobId)) {
    state.appended.delete(jobId);
    state.done.delete(jobId);
    return;
  }
  context.setEntries((rows) => {
    if (context.turnRunning() && !hasJobPanel(rows, jobId)) {
      state.appended.delete(jobId);
      state.done.delete(jobId);
      return rows;
    }
    return upsertJobPanel(rows, view);
  });
  state.appended.add(jobId);
  if (view.state !== "running") state.done.add(jobId);
}

/** Whether the job the registry holds now has stopped running, which it reports when it is gone. */
function hasEnded(context: PanelContext, jobId: string): boolean {
  const job = context.jobs.get(jobId);
  return job !== undefined && job.state !== "running";
}

/** Re-arms the refresh timer while a paneled job still runs, and clears it otherwise. */
function syncTimer(context: PanelContext, state: PanelState): void {
  const running = [...state.paneled].some((jobId) => context.jobs.get(jobId)?.state === "running");
  if (!running) {
    clearTimer(state);
    return;
  }
  if (state.timer !== undefined) return;
  // `setTimeout`, not `setInterval`: the handle is cancelled mid-flight on unmount and when the
  // last paneled job stops running, and an interval cannot be stopped before its next tick.
  state.timer = _jobPanelsDeps.setTimeout(() => {
    state.timer = undefined;
    if (!state.live) return;
    refreshPaneled(context, state);
    syncTimer(context, state);
  }, JOB_PANEL_REFRESH_MS);
}

/**
 * After a refresh settles: drain a queued one, or run the single post-end refresh still owed.
 *
 * A job showing its ended state is finished, so anything queued for it while that view was
 * read is dropped rather than run: the queued refresh would overwrite the panel that froze.
 */
function afterSettle(context: PanelContext, state: PanelState, jobId: string): void {
  if (state.done.has(jobId)) {
    state.queued.delete(jobId);
    return;
  }
  if (state.queued.delete(jobId)) {
    void refresh(context, state, jobId);
    return;
  }
  if (state.finalRequested.has(jobId)) return;
  if (!hasEnded(context, jobId)) return;
  state.finalRequested.add(jobId);
  void refresh(context, state, jobId);
}

/**
 * Reads one job's view and applies it; a refresh for the same job never overlaps this one.
 *
 * A job whose terminal view has been applied is never read again — its panel is the last word
 * on it — so a change announced while that view was being read cannot restart it.
 */
async function refresh(context: PanelContext, state: PanelState, jobId: string): Promise<void> {
  if (state.done.has(jobId)) {
    state.queued.delete(jobId);
    return;
  }
  if (state.inFlight.has(jobId)) {
    state.queued.add(jobId);
    return;
  }
  const job = context.jobs.get(jobId);
  if (job === undefined) return;
  state.inFlight.add(jobId);
  let view: JobPanelView | undefined;
  try {
    view = await _jobPanelsDeps.readJobPanelView(job, context.jobs, _jobPanelsDeps.now());
  } catch (error) {
    getLogger()?.warn("chat", "Job panel refresh failed; keeping the panel it has", {
      jobId,
      error: errorMessage(error),
    });
  } finally {
    state.inFlight.delete(jobId);
  }
  // A refresh still in flight when the hook went away applies nothing.
  if (!state.live) return;
  if (view !== undefined) applyView(context, state, jobId, view);
  if (!state.live) return;
  afterSettle(context, state, jobId);
  syncTimer(context, state);
}

/** Refreshes every paneled job, skipping the ones already showing their ended state. */
function refreshPaneled(context: PanelContext, state: PanelState): void {
  for (const jobId of state.paneled) {
    if (state.done.has(jobId)) continue;
    void refresh(context, state, jobId);
  }
}

/** Panels every job the registry reports running and that is not paneled yet. */
function panelRunning(context: PanelContext, state: PanelState): void {
  for (const job of context.jobs.running()) {
    if (state.paneled.has(job.id)) continue;
    state.paneled.add(job.id);
  }
}

/**
 * The turn's true-to-false edge: one refresh for every paneled job whose panel is not in the
 * transcript, so a job that started — or ended — during the turn appears now, at its final
 * state. This one refresh ignores the ended-panel guard: the panel was never shown.
 */
function flushHeldPanels(context: PanelContext, state: PanelState): void {
  for (const jobId of state.paneled) {
    if (state.appended.has(jobId)) continue;
    void refresh(context, state, jobId);
  }
}

/** Everything a job-registry change does: panel what started, then refresh what is shown. */
function onJobsChanged(context: PanelContext, state: PanelState): void {
  panelRunning(context, state);
  refreshPaneled(context, state);
  syncTimer(context, state);
}

export function useJobPanels(input: UseJobPanelsInput): void {
  const jobs = input.host.jobs;
  // Built once: the screen re-renders on every stream delta, so nothing here is per-render.
  const state = useRef<PanelState | null>(null);
  state.current ??= newState();
  const panels = state.current;
  // The turn, the transcript and the setter as they stand at the moment a refresh lands, not as
  // the render that started it saw them: a reply can still be streaming when a read resolves.
  const turnRunning = useRef(input.turnRunning);
  turnRunning.current = input.turnRunning;
  const entries = useRef(input.entries);
  entries.current = input.entries;
  const setEntries = useRef(input.setEntries);
  setEntries.current = input.setEntries;
  const previousTurnRunning = useRef(input.turnRunning);

  useEffect(() => {
    if (jobs === undefined) {
      panels.live = false;
      return undefined;
    }
    const context: PanelContext = {
      jobs,
      setEntries: (update) => setEntries.current(update),
      turnRunning: () => turnRunning.current,
      entries: () => entries.current,
    };
    panels.live = true;
    const unsubscribe = jobs.onChange(() => onJobsChanged(context, panels));
    // What was already running when the chat opened is paneled here, not on a later event.
    onJobsChanged(context, panels);
    return () => {
      panels.live = false;
      unsubscribe();
      clearTimer(panels);
      panels.paneled.clear();
      panels.appended.clear();
      panels.inFlight.clear();
      panels.queued.clear();
      panels.finalRequested.clear();
      panels.done.clear();
    };
  }, [jobs, panels]);

  useEffect(() => {
    const turned = previousTurnRunning.current !== input.turnRunning;
    previousTurnRunning.current = input.turnRunning;
    if (!turned || input.turnRunning || jobs === undefined || !panels.live) return;
    const context: PanelContext = {
      jobs,
      setEntries: (update) => setEntries.current(update),
      turnRunning: () => turnRunning.current,
      entries: () => entries.current,
    };
    flushHeldPanels(context, panels);
    syncTimer(context, panels);
  }, [input.turnRunning, jobs, panels]);
}
