/**
 * One POST to a SystemOne endpoint (spec 6.2).
 *
 * Total by construction: every failure maps to a ModelResult, so the promise
 * never rejects. It never retries (a retry adds load to a local model for data
 * that decides nothing) and never truncates (an oversize command is recorded
 * as `oversize`). The timeout is a config value, applied as an AbortSignal.
 */
import { buildRequest } from "./questions";
import { HARM_OPTIONS, type HarmOption, type ModelResult, QUESTION_IDS, type QuestionId } from "./types";

export type Classify = (command: string) => Promise<ModelResult>;

export interface SystemOneClientOptions {
  readonly url: string;
  readonly timeoutMs: number;
  readonly token?: string;
}

/** Injectable seams: tests drive the timeout by hand instead of waiting on it. */
export const _systemOneClientDeps = {
  fetch: (input: string, init: RequestInit): Promise<Response> => fetch(input, init),
  timeoutSignal: (ms: number): AbortSignal => AbortSignal.timeout(ms),
  now: (): number => performance.now(),
};

const isTimeout = (err: unknown): boolean =>
  typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";

export function createSystemOneClient(opts: SystemOneClientOptions): Classify {
  return async (command) => {
    const started = _systemOneClientDeps.now();
    const elapsed = () => Math.round(_systemOneClientDeps.now() - started);
    const unavailable = (error: string): ModelResult => ({ status: "unavailable", error, latencyMs: elapsed() });
    let res: Response;
    try {
      res = await _systemOneClientDeps.fetch(opts.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(opts.token !== undefined && opts.token.length > 0 ? { authorization: `Bearer ${opts.token}` } : {}),
        },
        body: JSON.stringify(buildRequest(command)),
        signal: _systemOneClientDeps.timeoutSignal(opts.timeoutMs),
      });
    } catch (err) {
      return unavailable(isTimeout(err) ? "timeout" : "network");
    }
    if (res.status === 413) return { status: "oversize", latencyMs: elapsed() };
    if (res.status === 401) return unavailable("unauthorized");
    if (res.status !== 200) return unavailable(`http_${res.status}`);
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      return unavailable(isTimeout(err) ? "timeout" : "malformed");
    }
    return parseAnswer(body, elapsed());
  };
}

const isProbability = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const record = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** Map a 200 body to a ModelResult. Anything short of all seven valid answers is `malformed`. */
export function parseAnswer(body: unknown, latencyMs: number): ModelResult {
  const malformed: ModelResult = { status: "unavailable", error: "malformed", latencyMs };
  const top = record(body);
  if (top === undefined) return malformed;
  const decision = record(top.x_proxy)?.decision_id;
  const decisionId = typeof decision === "string" ? decision : undefined;
  if (record(top.error)?.kind === "provider_blocked") {
    return { status: "blocked", ...(decisionId !== undefined ? { decisionId } : {}), latencyMs };
  }
  const answers = record(top.answers);
  const probabilities = record(record(answers?.harm)?.probabilities);
  if (answers === undefined || probabilities === undefined) return malformed;
  const harm: Partial<Record<HarmOption, number>> = {};
  for (const option of HARM_OPTIONS) {
    const p = probabilities[option];
    if (!isProbability(p)) return malformed;
    harm[option] = p;
  }
  const noul: Partial<Record<QuestionId, number>> = {};
  for (const id of QUESTION_IDS) {
    const p = record(answers[id])?.noul;
    if (!isProbability(p)) return malformed;
    noul[id] = p;
  }
  return {
    status: "answered",
    answers: { harm: harm as Record<HarmOption, number>, noul: noul as Record<QuestionId, number> },
    ...(typeof top.model === "string" ? { model: top.model } : {}),
    ...(decisionId !== undefined ? { decisionId } : {}),
    latencyMs,
  };
}
