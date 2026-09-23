/**
 * A stub SystemOne endpoint on an ephemeral loopback port, for P5 contract and
 * integration tests. Reproduces the REFUSAL modes as well as success
 * (master plan §5: a double that cannot fail the way production fails hides
 * criticals).
 */
import { HARM_OPTIONS, QUESTION_IDS } from "@/command-safety";

export type StubMode =
  | "answer"
  | "hang"
  | "reject"
  | "malformed"
  | "unauthorized"
  | "blocked"
  | { readonly oversizeAbove: number };

export function stubAnswerBody(): Record<string, unknown> {
  return {
    id: "dp_stub",
    model: "stub@1",
    answers: {
      harm: {
        type: "choice",
        probabilities: Object.fromEntries(HARM_OPTIONS.map((o) => [o, o === "none" ? 0.9 : 0.01])),
      },
      ...Object.fromEntries(QUESTION_IDS.map((id) => [id, { type: "noul", noul: 0.1 }])),
    },
    x_proxy: { decision_id: "dp_stub" },
  };
}

export function startSystemOneStub(mode: StubMode): { url: string; requests: () => number; stop(): void } {
  let count = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      count++;
      const body = await req.text();
      if (typeof mode === "object") {
        return body.length > mode.oversizeAbove
          ? Response.json({ error: { kind: "oversize" } }, { status: 413 })
          : Response.json(stubAnswerBody());
      }
      switch (mode) {
        case "hang":
          return new Promise<Response>(() => {});
        case "reject":
          return Response.json({ error: { kind: "unavailable" } }, { status: 503 });
        case "malformed":
          return new Response("<html>not json</html>", { status: 200 });
        case "unauthorized":
          return Response.json({ error: { kind: "unauthorized" } }, { status: 401 });
        case "blocked":
          return Response.json({
            error: { kind: "provider_blocked" },
            x_proxy: { decision_id: "dp_b", blocked: true },
          });
        default:
          return Response.json(stubAnswerBody());
      }
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/t/nax-command-safety/v1/systemone`,
    requests: () => count,
    stop: () => server.stop(true),
  };
}
