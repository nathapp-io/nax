import { errorMessage } from "@nathapp/nax-agent/internal";
import { getLogger } from "@/logger";
import { configFactsFor } from "./config-change-absorb";
import { ledgerText } from "./ledger";
import type { StoryLoopEnv } from "./story-loop";
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

async function readTimeoutFacts(env: StoryLoopEnv): Promise<{ baselineTimedOut: boolean; limitSeconds?: number }> {
  try {
    return (await env.steps.timeoutFacts?.()) ?? { baselineTimedOut: false };
  } catch (err) {
    getLogger().warn("workflow", "Timeout facts could not be read", { storyId: env.storyId, error: errorMessage(err) });
    return { baselineTimedOut: false };
  }
}

/** Route only current-pass timeouts; suite results from earlier passes are not current. */
export async function stopOnTimeout(
  env: StoryLoopEnv,
  input: Omit<GateTimeoutRouteInput, "baselineTimedOut">,
  asked: boolean,
): Promise<boolean> {
  if (!(input.current?.timedOut?.length || input.currentSuite?.timedOut?.length)) return false;
  const facts = await readTimeoutFacts(env);
  const route = gateTimeoutRoute({ ...input, baselineTimedOut: facts.baselineTimedOut });
  if (!route) return false;
  if (asked) return true;
  const previous = [...(input.previous?.timedOut ?? []), ...(input.previousSuite?.timedOut ?? [])];
  const timing = { ...facts, gates: route.gates, repeated: route.gates.some((gate) => previous.includes(gate)) };
  const config = route.gates.includes("scoped") ? await configFactsFor(env, ["scoped"]) : undefined;
  await env.sink.ledger(
    ledgerText.note(`gate timeout on ${route.gates.join(", ")} (${route.why}): no fix round, asked the advisor`),
  );
  let answer: Awaited<ReturnType<typeof env.advisor.answerQuestion>>;
  try {
    answer = await env.advisor.answerQuestion({
      storyId: env.storyId,
      status: "GATE_TIMEOUT",
      concerns: "A gate timed out.",
      timing,
      ...(config === undefined ? {} : { facts: config }),
    });
  } catch (err) {
    getLogger().warn("workflow", "Gate timeout advisor failed", { storyId: env.storyId, error: errorMessage(err) });
    return true;
  }
  if (typeof answer === "string") await env.sink.ledger(ledgerText.note(`gate timeout advice: ${answer}`));
  return true;
}
