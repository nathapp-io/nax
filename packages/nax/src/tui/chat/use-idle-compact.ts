/**
 * Idle compaction for the chat screen (chat-job-panel US-007).
 *
 * A long `nax run` leaves the chat idle for the whole job, and nothing used to react to that:
 * the native session compacted only when its own history reached the configured cap. This hook
 * arms the compactor in `chat-compaction.ts` on every render and hands it the chat as it stands
 * — idle or mid-turn, the first running job, the footer's context reading, and whether the model
 * is an ACP agent (which owns its context, so it is never armed).
 *
 * The compaction itself is the screen's own `compactTurn`, so a background compaction draws the
 * working line, the notices and the turn slot exactly as `/compact` does. This module therefore
 * holds no compaction logic of its own: it only decides *when*.
 */
import { useEffect, useRef } from "react";
import { type ChatHost, createIdleCompactor, type IdleCompactor, isChatAcpModel } from "@/chat";

export interface UseIdleCompactInput {
  readonly host: ChatHost;
  /** How long the chat sits idle before compacting; 0 turns it off. */
  readonly delayMs: number;
  readonly turnRunning: boolean;
  /** The footer's context reading; absent until a usage event reports one. */
  readonly contextTokens?: number;
  readonly compact: () => Promise<void>;
  readonly note: (text: string) => void;
}

/** What the screen calls when the compactor reports a reason. */
interface DueHandlers {
  readonly compact: () => Promise<void>;
  readonly note: (text: string) => void;
}

/**
 * The first running job's id, or undefined when no job runs. One job is compacted for at a
 * time: the panel and the footer already show only what is worth showing, and a second job's
 * compaction waits for its own idle period.
 */
function runningJobId(host: ChatHost): string | undefined {
  return host.jobs?.running()[0]?.id;
}

/**
 * Compact the native chat once per running job after `delayMs` of idle time (US-007).
 *
 * The compactor is built once per mount, so its fired-job history and its armed timer survive
 * ordinary re-renders — a stream delta must not restart the delay. That also means `delayMs` is
 * read once: it comes from the loaded config, which does not change under a running screen. The
 * latest `compact` and `note` are held in refs, because the timer fires long after the render
 * that armed it and must call the screen's newest closures. `update` runs on every render: it is
 * how the compactor learns that the turn ended, the job started, or the context grew enough to
 * qualify.
 */
export function useIdleCompact(input: UseIdleCompactInput): void {
  const { host, delayMs, turnRunning, contextTokens, compact, note } = input;
  const due = useRef<DueHandlers>({ compact, note });
  due.current = { compact, note };
  const compactor = useRef<IdleCompactor | undefined>(undefined);
  compactor.current ??= createIdleCompactor({
    delayMs,
    onDue: (reason) => {
      due.current.note(`idle compact: ${reason}`);
      void due.current.compact();
    },
  });
  useEffect(() => () => compactor.current?.dispose(), []);
  const jobId = runningJobId(host);
  compactor.current.update({
    idle: !turnRunning,
    ...(jobId === undefined ? {} : { runningJobId: jobId }),
    ...(contextTokens === undefined ? {} : { contextTokens }),
    acp: isChatAcpModel(host.current().model),
  });
}
