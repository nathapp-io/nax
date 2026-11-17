import { errorMessage } from "@nathapp/nax-agent/internal";
import { type RefObject, useEffect, useRef, useState } from "react";
import type { ChatHost } from "@/chat";
import type { BackgroundTask } from "@/chat/background/task-types";
import type { ChatJob } from "@/chat/jobs/job-types";
import { getLogger } from "@/logger";
import { summarizeBackgroundNotice } from "@/prompts";

interface JobsOptions {
  readonly idle: boolean;
  readonly note: (text: string) => void;
  readonly deliver: (notice: string) => Promise<boolean>;
}

/** The default for `interaction.defaults.chatTaskNoticeTurns`; the host passes the configured value. */
export const MAX_CONSECUTIVE_TASK_NOTICE_TURNS = 3;

/**
 * The transcript row drawn once when an ended task's notice is held by the guard (#2816), so a
 * chat that stops waking the agent says why instead of going quiet until the user types.
 */
export function taskNoticeHeldLine(limit: number): string {
  return limit === 0
    ? "background task ended · auto-wake is off · send a message to continue"
    : `background task ended · auto-wake paused after ${limit} task turns in a row · send a message to continue`;
}

/** The transcript row for a task notice the running turn took as a steer. */
export function steeredTaskNoticeLine(summary: string): string {
  return `${summary} · sent into the running turn`;
}

/** What a steered notice is drawn as when `summarizeBackgroundNotice` cannot name it. */
const STEERED_NOTICE_FALLBACK = "background task notice";
/** One message for both ways a steer leaves the notice alone: thrown, and refused by `applied`. */
const STEER_RETAINED = "Background notice steer failed; notice retained";

interface SteerOptions {
  /** Idle means the notice starts a turn of its own; a steer is for a turn already running. */
  readonly idle: boolean;
  /** The whole host, so `steer` is called on the object that owns it. */
  readonly host: ChatHost;
  readonly tasks: ChatHost["tasks"];
  readonly note: (text: string) => void;
  /** Shared with the delivery path, whose notice turn must never steer its own notice. */
  readonly inFlight: RefObject<boolean>;
  /** Set while a steer waits for its `applied`: the idle path holds only its task source. */
  readonly pending: RefObject<boolean>;
  /** Re-render, so the head that follows an applied steer is considered. */
  readonly refresh: () => void;
  readonly mounted: RefObject<boolean>;
}

/** What settling a steer needs once the head notice has been taken from the queue. */
interface SteerRun extends Omit<SteerOptions, "idle" | "host" | "inFlight"> {
  /** The head text this chat already offered and did not get applied. */
  readonly refused: RefObject<string | undefined>;
}

/** The notice is acknowledged and the transcript says where it went. */
function noteSteeredNotice(run: SteerRun, notice: string): void {
  run.tasks?.takeNotice();
  const summary = summarizeBackgroundNotice(notice) ?? STEERED_NOTICE_FALLBACK;
  run.note(steeredTaskNoticeLine(summary));
}

/** Settle one accepted steer: acknowledge it, or keep it refused, then let the next head be seen. */
function settleSteer(run: SteerRun, notice: string, applied: Promise<boolean>): void {
  void applied
    .then((taken) => {
      if (taken) noteSteeredNotice(run, notice);
      else run.refused.current = notice;
    })
    .catch((error: unknown) => {
      getLogger()?.warn("chat", STEER_RETAINED, { error: errorMessage(error) });
      run.refused.current = notice;
    })
    .finally(() => {
      run.pending.current = false;
      if (run.mounted.current) run.refresh();
    });
}

/** A steer the turn would not take: the notice stays queued and is not offered again. */
function keepNotice(run: SteerRun, notice: string): void {
  run.pending.current = false;
  run.refused.current = notice;
}

/**
 * Hand a background task notice that ended mid-turn to that turn (US-003).
 *
 * A new turn for the notice would re-report a result the agent already has, so the notice
 * goes into the running one. Only `applied: true` acknowledges it; a refusal, a rejection, a
 * thrown call or a brain that cannot steer leaves the notice queued, recorded as refused so
 * the same text is not offered again until the chat has been idle. Nothing here waits for
 * `applied`: the idle path delivers what a steer could not, and only a task notice waits.
 */
function useTaskNoticeSteer(options: SteerOptions): void {
  const { idle, host, tasks, inFlight, pending } = options;
  /** The head text this chat already offered and did not get applied. */
  const refused = useRef<string | undefined>(undefined);
  const run: SteerRun = { ...options, refused };

  useEffect(() => {
    if (idle) {
      refused.current = undefined;
      return;
    }
    // A notice turn of the idle path's own, or a steer already waiting, owns the head.
    if (host.steer === undefined || pending.current || inFlight.current) return;
    const notice = tasks?.peekNotice();
    if (notice === undefined || notice === refused.current) return;
    pending.current = true;
    try {
      const result = host.steer(notice);
      if (result.status === "accepted") settleSteer(run, notice, result.applied);
      else keepNotice(run, notice);
    } catch (error) {
      getLogger()?.warn("chat", STEER_RETAINED, { error: errorMessage(error) });
      keepNotice(run, notice);
    }
  });
}

interface HeldNoticeInput {
  readonly tasks: ChatHost["tasks"];
  /** The source the idle path settled on; anything but `undefined` means a notice was taken. */
  readonly source: unknown;
  /** True once the held notice has been announced; set here, cleared by a delivery. */
  readonly held: RefObject<boolean>;
  /** A steer is still waiting for its `applied`: its notice is held by the steer, not the guard. */
  readonly heldBySteer: boolean;
  readonly limit: number;
  readonly note: (text: string) => void;
}

/** Announce once that the guard is holding an ended task's notice (#2816), so the chat says why. */
function announceHeldTaskNotice(input: HeldNoticeInput): void {
  // Any chosen source was a delivery, not a hold; a pending steer holds its notice itself.
  if (input.source !== undefined || input.held.current || input.heldBySteer) return;
  if (input.tasks?.peekNotice() === undefined) return;
  input.held.current = true;
  input.note(taskNoticeHeldLine(input.limit));
}

/** Deliver run asks before job notices, then bounded autonomous task turns, only while idle. */
export function useJobs(
  host: ChatHost,
  { idle, deliver, note }: JobsOptions,
): {
  running: readonly ChatJob[];
  /** Running host-owned background tasks, refreshed by the task subscription. */
  tasks: readonly BackgroundTask[];
  /** Foreground availability refreshed by the same task subscription as notices. */
  backgroundable: boolean;
  noteUserTurn(): void;
} {
  const jobs = host.jobs;
  const tasks = host.tasks;
  const runAsks = host.runAsks;
  const taskTurns = useRef(0);
  const taskTurnLimit = host.taskNoticeTurns ?? MAX_CONSECUTIVE_TASK_NOTICE_TURNS;
  /** True once the held task notice has been announced; cleared when a task notice is delivered. */
  const heldAnnounced = useRef(false);
  const [, refresh] = useState(0);
  const latestDeliver = useRef(deliver);
  latestDeliver.current = deliver;
  const inFlight = useRef(false);
  const mounted = useRef(false);
  /** Set while a task steer waits for its `applied`: the idle path then holds that source. */
  const steerPending = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const changed = () => refresh((revision) => revision + 1);
    const unsubscribe = jobs?.onChange(changed);
    const unsubscribeTasks = tasks?.onChange(changed);
    const unsubscribeAsks = runAsks?.onChange(changed);
    return () => {
      mounted.current = false;
      unsubscribe?.();
      unsubscribeTasks?.();
      unsubscribeAsks?.();
    };
  }, [jobs, tasks, runAsks]);

  useEffect(() => {
    for (const line of runAsks?.takeNotes() ?? []) note(line);
  });

  // Check on every render: an idle transition or a job notification can unblock the head.
  useEffect(() => {
    if (!idle || inFlight.current) return;
    const askNotice = runAsks?.peekNotice();
    const jobNotice = jobs?.peekNotice();
    // A steer that is still waiting for its `applied` holds the task source alone: a run ask
    // or a job notice is not steerable and is delivered as it always was.
    const taskSource = steerPending.current ? undefined : tasks;
    const source =
      askNotice !== undefined
        ? runAsks
        : jobNotice !== undefined
          ? jobs
          : taskTurns.current < taskTurnLimit
            ? taskSource
            : undefined;
    const notice = askNotice ?? jobNotice ?? source?.peekNotice();
    if (notice === undefined) {
      // A task source a pending steer holds is not the guard's hold: it announces nothing.
      announceHeldTaskNotice({
        tasks,
        source,
        held: heldAnnounced,
        heldBySteer: steerPending.current,
        limit: taskTurnLimit,
        note,
      });
      return;
    }
    inFlight.current = true;
    void (async () => {
      let delivered = false;
      try {
        delivered = await latestDeliver.current(notice);
        if (delivered) {
          if (source === runAsks) runAsks?.takeNotice(notice);
          else source?.takeNotice();
          if (source === tasks) {
            taskTurns.current++;
            heldAnnounced.current = false;
          }
        }
      } catch (error) {
        getLogger()?.warn("chat", "Background notice delivery failed; notice retained", { error: errorMessage(error) });
      } finally {
        inFlight.current = false;
        // Drain the next head even when the turn's final render preceded this continuation.
        // A declined delivery waits for another render, never a busy retry loop.
        if (delivered && mounted.current) refresh((revision) => revision + 1);
      }
    })();
  });

  useTaskNoticeSteer({
    idle,
    host,
    tasks,
    note,
    inFlight,
    pending: steerPending,
    refresh: () => refresh((revision) => revision + 1),
    mounted,
  });

  return {
    running: jobs?.running() ?? [],
    tasks: tasks?.running() ?? [],
    backgroundable: tasks?.hasForeground() ?? false,
    noteUserTurn: () => {
      taskTurns.current = 0;
      runAsks?.noteUserTurn();
    },
  };
}
