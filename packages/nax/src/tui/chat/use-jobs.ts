import { errorMessage } from "@nathapp/nax-agent/internal";
import { useEffect, useRef, useState } from "react";
import type { ChatHost } from "@/chat";
import type { ChatJob } from "@/chat/jobs/job-types";
import { getLogger } from "@/logger";

interface JobsOptions {
  readonly idle: boolean;
  readonly deliver: (notice: string) => Promise<boolean>;
}

/** Subscribe to jobs and acknowledge FIFO notices only after a turn really started. */
export function useJobs(host: ChatHost, { idle, deliver }: JobsOptions): readonly ChatJob[] {
  const jobs = host.jobs;
  const [, refresh] = useState(0);
  const latestDeliver = useRef(deliver);
  latestDeliver.current = deliver;
  const inFlight = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = jobs?.onChange(() => refresh((revision) => revision + 1));
    return () => {
      mounted.current = false;
      unsubscribe?.();
    };
  }, [jobs]);

  // Check on every render: an idle transition or a job notification can unblock the head.
  useEffect(() => {
    if (!idle || !jobs || inFlight.current) return;
    const notice = jobs.peekNotice();
    if (notice === undefined) return;
    inFlight.current = true;
    void (async () => {
      let delivered = false;
      try {
        delivered = await latestDeliver.current(notice);
        if (delivered) jobs.takeNotice();
      } catch (error) {
        getLogger()?.warn("chat", "Job notice delivery failed; notice retained", { error: errorMessage(error) });
      } finally {
        inFlight.current = false;
        // Drain the next head even when the turn's final render preceded this continuation.
        // A declined delivery waits for another render, never a busy retry loop.
        if (delivered && mounted.current) refresh((revision) => revision + 1);
      }
    })();
  });
  return jobs?.running() ?? [];
}
