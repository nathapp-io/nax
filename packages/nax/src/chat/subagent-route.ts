/**
 * Where one nested run's session events go, and how a foreground run changes that mid-flight.
 *
 * A foreground run forwards its tool activity to the parent turn's listener (the Agent card in
 * the transcript) and keeps every event in a bounded log. A background run, or a foreground run
 * that has been moved to the background, instead records every event on its task and writes one
 * `[tool] <name>` line per call to the task log. The move replays the log into the task first,
 * so the task's view starts from the run's first event, then flips the route.
 */
import type { SessionEvent } from "@nathapp/nax-agent";
import { type BackgroundAgentSink, createTaskEventLog, type TaskEventLog } from "./background";

export interface RunRoute {
  /**
   * Events seen while the run is foreground; emptied when the run moves to a task. Absent for a
   * run no registry can adopt, which has nothing to replay and so must not pay for a log.
   */
  readonly log?: TaskEventLog;
  /** Set once the run belongs to a task; from then on the parent turn sees none of its activity. */
  sink?: BackgroundAgentSink;
  /** The parent turn the run became a background run in; its spend is ineligible until a later turn. */
  backgroundTurn?: number;
}

/** A route for a run that is foreground until moved. */
export function foregroundRoute(): RunRoute {
  return { log: createTaskEventLog() };
}

/** A route for a foreground run no registry can adopt: it forwards to the turn and keeps nothing. */
export function untrackedRoute(): RunRoute {
  return {};
}

/** A route for a run that is a task from its first event. */
export function taskRoute(sink: BackgroundAgentSink, turn: number): RunRoute {
  return { sink, backgroundTurn: turn };
}

function writeToTask(sink: BackgroundAgentSink, event: SessionEvent): void {
  sink.record(event);
  if (event.type === "tool_call") sink.appendLine(`[tool] ${event.name}`);
}

/** Hand a foreground run over to `sink`: replay what it did so far, then route what it does next. */
export function moveRouteToTask(route: RunRoute, sink: BackgroundAgentSink, turn: number): void {
  for (const event of route.log?.snapshot() ?? []) writeToTask(sink, event);
  route.log?.clear();
  route.sink = sink;
  route.backgroundTurn = turn;
}

/** Deliver one event: to the task when the run belongs to one, else to the log and the turn's listener. */
export function deliverActivity(
  event: SessionEvent,
  route: RunRoute,
  forward: ((event: SessionEvent) => void) | undefined,
): void {
  if (route.sink !== undefined) {
    writeToTask(route.sink, event);
    return;
  }
  route.log?.append(event);
  if (event.type === "tool_call" || event.type === "tool_result") forward?.(event);
}
