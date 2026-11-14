import type { GateName, GateRunResult } from "./types";

export interface GateTimeoutRouteInput {
  readonly previous: GateRunResult | undefined;
  readonly previousSuite: GateRunResult | undefined;
  readonly current: GateRunResult | undefined;
  readonly currentSuite: GateRunResult | undefined;
  readonly baselineTimedOut: boolean;
}

export interface GateTimeoutRoute {
  readonly gates: readonly GateName[];
  readonly why: "baseline" | "repeated";
}

export function gateTimeoutRoute(input: GateTimeoutRouteInput): GateTimeoutRoute | null {
  const gates = [...new Set([...(input.current?.timedOut ?? []), ...(input.currentSuite?.timedOut ?? [])])];
  if (gates.length === 0) return null;
  if (input.baselineTimedOut) return { gates, why: "baseline" };
  const previous = [...(input.previous?.timedOut ?? []), ...(input.previousSuite?.timedOut ?? [])];
  return gates.some((gate) => previous.includes(gate)) ? { gates, why: "repeated" } : null;
}
