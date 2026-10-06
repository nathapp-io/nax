/**
 * An in-process ACP agent for the unit suite (D-k): `launch` hands the backend
 * the fake agent's AgentApp instead of a process. kill() and terminate() end it
 * the way a real exit would (the backend then closes the connection) and are
 * counted, so tests can assert "the process group was killed".
 */
import { createStderrTail } from "@nathapp/nax-agent";
import type { AgentExit, LaunchedAgent, LaunchFn, LaunchRequest } from "#src/client/launch";
import { buildFakeAgent } from "#test/fixtures/fake-agent/agent";
import type { FakeRecord, FakeScript } from "#test/fixtures/fake-agent/script";

export interface InMemoryAgent {
  readonly launch: LaunchFn;
  readonly requests: readonly LaunchRequest[];
  callsTo(method: string): readonly unknown[];
  kills(): number;
  terminations(): number;
}

export function inMemoryAgent(script: FakeScript = {}): InMemoryAgent {
  const calls: FakeRecord[] = [];
  const requests: LaunchRequest[] = [];
  const counts = { kills: 0, terminations: 0 };
  const launch: LaunchFn = (request) => {
    requests.push(request);
    let end: (exit: AgentExit) => void = () => {};
    const exited = new Promise<AgentExit>((resolve) => {
      end = resolve;
    });
    const app = buildFakeAgent(script, {
      record: (method, params) => {
        calls.push({ method, params });
      },
      exit: () => {
        throw new Error("the exit step needs the subprocess fake (backend-process.test.ts)");
      },
    });
    const launched: LaunchedAgent = {
      target: { kind: "app", agent: app },
      pid: undefined,
      stderr: createStderrTail(),
      exited,
      whenGone: (waitMs) =>
        Promise.race([exited, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), waitMs))]),
      terminate: async () => {
        counts.terminations += 1;
        end({ code: 0, signal: null });
      },
      kill: () => {
        counts.kills += 1;
        end({ code: null, signal: "SIGKILL" });
      },
    };
    return launched;
  };
  return {
    launch,
    requests,
    callsTo: (method) => calls.filter((call) => call.method === method).map((call) => call.params),
    kills: () => counts.kills,
    terminations: () => counts.terminations,
  };
}
