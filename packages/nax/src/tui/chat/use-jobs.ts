import { errorMessage } from "@nathapp/nax-agent/internal";
import { useEffect, useRef, useState } from "react";
import type { ChatHost } from "@/chat";
import type { BackgroundTask } from "@/chat/background/task-types";
import type { ChatJob } from "@/chat/jobs/job-types";
import { getLogger } from "@/logger";

interface JobsOptions {
  readonly idle: boolean;
  readonly note: (text: string) => void;
  readonly deliver: (notice: string) => Promise<boolean>;
}

export const MAX_CONSECUTIVE_TASK_NOTICE_TURNS = 3;

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
  const [, refresh] = useState(0);
  const latestDeliver = useRef(deliver);
  latestDeliver.current = deliver;
  const inFlight = useRef(false);
  const mounted = useRef(false);

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
    const source =
      askNotice !== undefined
        ? runAsks
        : jobNotice !== undefined
          ? jobs
          : taskTurns.current < MAX_CONSECUTIVE_TASK_NOTICE_TURNS
            ? tasks
            : undefined;
    const notice = askNotice ?? jobNotice ?? source?.peekNotice();
    if (notice === undefined) return;
    inFlight.current = true;
    void (async () => {
      let delivered = false;
      try {
        delivered = await latestDeliver.current(notice);
        if (delivered) {
          if (source === runAsks) runAsks?.takeNotice(notice);
          else source?.takeNotice();
          if (source === tasks) taskTurns.current++;
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
