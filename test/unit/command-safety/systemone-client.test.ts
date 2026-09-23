import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mockFetch } from "@test/helpers";
import { _systemOneClientDeps, createSystemOneClient, HARM_OPTIONS, parseAnswer, QUESTION_IDS } from "@/command-safety";

const URL_ = "http://127.0.0.1:8020/t/nax-command-safety/v1/systemone";

/** A valid body, optionally broken in exactly one way (built, never mutated or cast). */
function answeredBody(opts: { omitNoul?: string; omitHarm?: string; privilegeNoul?: unknown } = {}) {
  const probabilities = Object.fromEntries(
    HARM_OPTIONS.filter((o) => o !== opts.omitHarm).map((o) => [o, o === "none" ? 0.94 : 0.01]),
  );
  const noul = Object.fromEntries(
    QUESTION_IDS.filter((id) => id !== opts.omitNoul).map((id) => [
      id,
      { type: "noul", noul: id === "privilege" && "privilegeNoul" in opts ? opts.privilegeNoul : 0.05 },
    ]),
  );
  return {
    id: "dp_1",
    model: "laya:typed-decisions@x",
    answers: { harm: { type: "choice", choice: "none", probabilities }, ...noul },
    x_proxy: { decision_id: "dp_1" },
  };
}

let orig: typeof _systemOneClientDeps;
let calls: { url: string; init: RequestInit }[];
let controller: AbortController;

beforeEach(() => {
  orig = { ..._systemOneClientDeps };
  calls = [];
  controller = new AbortController();
  _systemOneClientDeps.timeoutSignal = () => controller.signal;
  let t = 0;
  _systemOneClientDeps.now = () => (t += 5);
});
afterEach(() => {
  Object.assign(_systemOneClientDeps, orig);
});

function respond(status: number, body: unknown) {
  _systemOneClientDeps.fetch = mockFetch(async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  });
}

describe("createSystemOneClient", () => {
  test("posts buildRequest's body with a bearer token when one is given", async () => {
    respond(200, answeredBody());
    await createSystemOneClient({ url: URL_, timeoutMs: 3000, token: "t0k" })("git status");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(URL_);
    expect(calls[0]?.init.method).toBe("POST");
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer t0k");
    expect(JSON.parse(String(calls[0]?.init.body)).state).toEqual({ command: "git status" });
  });

  test("sends no Authorization header without a token", async () => {
    respond(200, answeredBody());
    await createSystemOneClient({ url: URL_, timeoutMs: 3000 })("ls");
    expect(new Headers(calls[0]?.init.headers).has("authorization")).toBe(false);
  });

  test("200 with all seven answers -> answered, with model, decisionId and latency", async () => {
    respond(200, answeredBody());
    const r = await createSystemOneClient({ url: URL_, timeoutMs: 3000 })("ls");
    expect(r.status).toBe("answered");
    if (r.status === "answered") {
      expect(r.answers.harm.none).toBe(0.94);
      expect(r.answers.noul.discards_work).toBe(0.05);
      expect(r.model).toBe("laya:typed-decisions@x");
      expect(r.decisionId).toBe("dp_1");
      expect(r.latencyMs).toBe(5);
    }
  });

  test("provider_blocked -> blocked, keeping the decision id", async () => {
    respond(200, { error: { kind: "provider_blocked" }, x_proxy: { decision_id: "dp_2", blocked: true } });
    const r = await createSystemOneClient({ url: URL_, timeoutMs: 3000 })("cat /etc/passwd");
    expect(r).toEqual({ status: "blocked", decisionId: "dp_2", latencyMs: 5 });
  });

  test("413 -> oversize (never truncated, never retried)", async () => {
    respond(413, { error: { kind: "oversize" } });
    const r = await createSystemOneClient({ url: URL_, timeoutMs: 3000 })("x".repeat(50_000));
    expect(r.status).toBe("oversize");
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]?.init.body)).state.command).toHaveLength(50_000);
  });

  test.each([
    [401, "unauthorized"],
    [404, "http_404"],
    [422, "http_422"],
    [503, "http_503"],
  ])("HTTP %d -> unavailable %s", async (status, error) => {
    respond(status, { error: {} });
    const r = await createSystemOneClient({ url: URL_, timeoutMs: 3000 })("ls");
    expect(r).toEqual({ status: "unavailable", error, latencyMs: 5 });
  });

  test("malformed JSON -> unavailable malformed", async () => {
    respond(200, "<html>nope</html>");
    const r = await createSystemOneClient({ url: URL_, timeoutMs: 3000 })("ls");
    expect(r.status === "unavailable" && r.error).toBe("malformed");
  });

  test("a network failure -> unavailable network", async () => {
    _systemOneClientDeps.fetch = mockFetch(async () => {
      throw new TypeError("connection refused");
    });
    const r = await createSystemOneClient({ url: URL_, timeoutMs: 3000 })("ls");
    expect(r.status === "unavailable" && r.error).toBe("network");
  });

  test("the timeout signal aborting -> unavailable timeout", async () => {
    _systemOneClientDeps.fetch = mockFetch(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const pending = createSystemOneClient({ url: URL_, timeoutMs: 3000 })("ls");
    controller.abort(new DOMException("timed out", "TimeoutError"));
    const r = await pending;
    expect(r.status === "unavailable" && r.error).toBe("timeout");
  });

  test("the timeout signal is built from the configured timeoutMs", async () => {
    const seen: number[] = [];
    _systemOneClientDeps.timeoutSignal = (ms) => {
      seen.push(ms);
      return controller.signal;
    };
    respond(200, answeredBody());
    await createSystemOneClient({ url: URL_, timeoutMs: 1234 })("ls");
    expect(seen).toEqual([1234]);
  });
});

describe("parseAnswer", () => {
  test.each([
    ["a missing noul", () => answeredBody({ omitNoul: "privilege" })],
    ["a harm option missing", () => answeredBody({ omitHarm: "privilege" })],
    ["a non-numeric noul", () => answeredBody({ privilegeNoul: "high" })],
    ["a value above 1", () => answeredBody({ privilegeNoul: 1.5 })],
    ["no answers at all", () => ({ model: "m" })],
    ["a non-object", () => "text"],
  ])("%s -> unavailable malformed", (_label, make) => {
    const r = parseAnswer(make(), 1);
    expect(r).toEqual({ status: "unavailable", error: "malformed", latencyMs: 1 });
  });
});
