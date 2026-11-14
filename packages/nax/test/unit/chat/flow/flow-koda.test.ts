/**
 * flow-koda.ts — the one call that creates a koda flow.
 *
 * The request goes through nax's own koda client, so it carries the configured
 * agent key and the bounded deadline. `_flowKodaDeps.createKodaClient` is the
 * seam: it is what a test can read the timeout off, since the fetch substitute
 * only ever sees the request.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { withDepsRestore } from "@test/helpers";
import {
  _flowKodaDeps,
  createKodaFlow,
  FLOW_KODA_REQUEST_TIMEOUT_MS,
  type FlowCreateBody,
  type KodaFlowConnection,
} from "@/chat/flow";
import { NaxError } from "@/errors";
import { _kodaClientDeps, type CreateKodaClientInput, createKodaClient, kodaStatusOf } from "@/memory/koda-http";

withDepsRestore(_flowKodaDeps, ["createKodaClient"]);
withDepsRestore(_kodaClientDeps, ["fetch"]);

const SHA = "0123456789abcdef0123456789abcdef01234567";

const connection: KodaFlowConnection = {
  url: "https://koda.example/api",
  headers: { Authorization: "Bearer k" },
};

const body: FlowCreateBody = {
  remoteUrl: "https://github.com/nathapp-io/nax",
  branch: "feat/nax-flow-send",
  specSha: SHA,
  features: [
    { feature: "nax-flow-send", specPath: ".nax/features/nax-flow-send/spec.md", dependsOn: [] },
    { feature: "nax-flow-docs", specPath: ".nax/features/nax-flow-docs/spec.md", dependsOn: ["nax-flow-send"] },
  ],
  roles: { reviewer: "acp:codex", supervisor: "acp:claude" },
  costCapUsd: 5,
};

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

let fetchCalls: FetchCall[] = [];
let clientInputs: CreateKodaClientInput[] = [];

/** A koda envelope answer carrying `status`. */
function jsonAnswer(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ret: 0, data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A koda failure envelope, which the client turns into `MEMORY_KODA_HTTP`. */
function failureAnswer(status: number, message: string): Response {
  return new Response(JSON.stringify({ ret: status, message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Serve every request with `answer`, and record both the client `createKodaFlow`
 * built and the request the real client sent through the fetch seam.
 */
function stubKoda(answer: () => Response): void {
  _flowKodaDeps.createKodaClient = (input) => {
    clientInputs.push(input);
    return createKodaClient(input);
  };
  _kodaClientDeps.fetch = async (input, init) => {
    fetchCalls.push({ url: input, init });
    return answer();
  };
}

/** The NaxError `promise` rejects with; fails the test when it resolves instead. */
async function rejection(promise: Promise<unknown>): Promise<NaxError> {
  const caught: unknown = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(caught instanceof NaxError)) throw new Error(`expected a NaxError, got ${String(caught)}`);
  return caught;
}

beforeEach(() => {
  fetchCalls = [];
  clientInputs = [];
  stubKoda(() => jsonAnswer({ id: "flow_1", state: "created", url: "/nax/flows/flow_1" }, 201));
});

describe("createKodaFlow — the request", () => {
  test("posts the body to the fleet/flows path with the flow timeout (AC-18)", () => {
    expect(FLOW_KODA_REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  test("builds the client from the connection with FLOW_KODA_REQUEST_TIMEOUT_MS (AC-18)", async () => {
    await createKodaFlow(connection, body);

    expect(clientInputs).toEqual([
      { url: connection.url, headers: connection.headers, timeoutMs: FLOW_KODA_REQUEST_TIMEOUT_MS },
    ]);
  });

  test("sends a POST to <url>/fleet/flows carrying the body unchanged (AC-18)", async () => {
    await createKodaFlow(connection, body);

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe("https://koda.example/api/fleet/flows");
    expect(fetchCalls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(fetchCalls[0]?.init.body))).toEqual(body);
  });

  test("joins the path onto a connection url that carries a trailing slash", async () => {
    await createKodaFlow({ ...connection, url: "https://koda.example/api/" }, body);

    expect(fetchCalls[0]?.url).toBe("https://koda.example/api/fleet/flows");
  });

  test("passes a given signal to the client's post as { signal } (AC-6)", async () => {
    const postCalls: unknown[][] = [];
    _flowKodaDeps.createKodaClient = () => ({
      get: async () => ({ status: 200, data: undefined }),
      post: async (path, sentBody, opts) => {
        postCalls.push([path, sentBody, opts]);
        return { status: 201, data: { id: "flow_1", state: "created", url: "/nax/flows/flow_1" } };
      },
    });
    const controller = new AbortController();

    await createKodaFlow(connection, body, controller.signal);

    expect(postCalls).toEqual([["fleet/flows", body, { signal: controller.signal }]]);
  });

  test("passes no options to post when the caller gave no signal (#2901)", async () => {
    const postCalls: unknown[][] = [];
    _flowKodaDeps.createKodaClient = () => ({
      get: async () => ({ status: 200, data: undefined }),
      post: async (path, sentBody, opts) => {
        postCalls.push([path, sentBody, opts]);
        return { status: 201, data: { id: "flow_1", state: "created", url: "/nax/flows/flow_1" } };
      },
    });

    await createKodaFlow(connection, body);

    expect(postCalls).toEqual([["fleet/flows", body, undefined]]);
  });
});

describe("createKodaFlow — the outcome", () => {
  test("returns the created flow for a 201 envelope (AC-18)", async () => {
    const data = { id: "flow_1", state: "pending_approval", url: "/nax/flows/flow_1" };
    stubKoda(() => jsonAnswer(data, 201));

    const outcome = await createKodaFlow(connection, body);

    expect(outcome).toEqual({ kind: "created", id: "flow_1", state: "pending_approval", url: "/nax/flows/flow_1" });
  });

  test("returns the approval request for a 202 envelope whose data.id is the request (AC-19)", async () => {
    stubKoda(() => jsonAnswer({ id: "req_1", tool: "fleet.flow.create" }, 202));

    const outcome = await createKodaFlow(connection, body);

    expect(outcome).toEqual({ kind: "held", requestId: "req_1" });
  });
});

describe("createKodaFlow — the failures", () => {
  test("rethrows the client's MEMORY_KODA_HTTP error unchanged on a 404 (AC-20)", async () => {
    stubKoda(() => failureAnswer(404, "repo not found"));

    const caught = await rejection(createKodaFlow(connection, body));

    expect(caught.code).toBe("MEMORY_KODA_HTTP");
    expect(kodaStatusOf(caught)).toBe(404);
    expect(caught.message).toContain("repo not found");
  });

  test("rethrows the very error instance the client threw (AC-20)", async () => {
    const thrown = new NaxError("[memory] koda POST fleet/flows answered 500: boom", "MEMORY_KODA_HTTP", {
      stage: "memory",
    });
    _flowKodaDeps.createKodaClient = () => ({
      get: async () => ({ status: 200, data: undefined }),
      post: async () => {
        throw thrown;
      },
    });

    const caught = await rejection(createKodaFlow(connection, body));

    expect(caught).toBe(thrown);
  });

  test("rethrows a MEMORY_KODA_TIMEOUT from the client unchanged", async () => {
    const thrown = new NaxError("[memory] koda POST fleet/flows timed out after 30000ms", "MEMORY_KODA_TIMEOUT", {
      stage: "memory",
    });
    _flowKodaDeps.createKodaClient = () => ({
      get: async () => ({ status: 200, data: undefined }),
      post: async () => {
        throw thrown;
      },
    });

    expect(await rejection(createKodaFlow(connection, body))).toBe(thrown);
  });

  test("throws FLOW_KODA_UNEXPECTED_RESPONSE for a 200 answer (AC-21)", async () => {
    stubKoda(() => jsonAnswer({ id: "flow_1", state: "ok", url: "/nax/flows/flow_1" }, 200));

    const caught = await rejection(createKodaFlow(connection, body));

    expect(caught.code).toBe("FLOW_KODA_UNEXPECTED_RESPONSE");
    expect(caught.message).toContain("200");
  });

  test.each([
    ["data is absent", undefined],
    ["data has no url", { id: "flow_1", state: "pending_approval" }],
    ["data has a non-string url", { id: "flow_1", state: "pending_approval", url: 7 }],
    ["data has no id", { state: "pending_approval", url: "/nax/flows/flow_1" }],
    ["data has no state", { id: "flow_1", url: "/nax/flows/flow_1" }],
  ])("throws FLOW_KODA_UNEXPECTED_RESPONSE for a 201 whose %s (AC-22)", async (_label, data) => {
    stubKoda(() => jsonAnswer(data, 201));

    const caught = await rejection(createKodaFlow(connection, body));

    expect(caught.code).toBe("FLOW_KODA_UNEXPECTED_RESPONSE");
    expect(caught.message).toContain("201");
  });

  test.each([
    ["data is absent", undefined],
    ["data has no id", { tool: "fleet.flow.create" }],
    ["data has a non-string id", { id: 1 }],
  ])("throws FLOW_KODA_UNEXPECTED_RESPONSE for a 202 whose %s", async (_label, data) => {
    stubKoda(() => jsonAnswer(data, 202));

    const caught = await rejection(createKodaFlow(connection, body));

    expect(caught.code).toBe("FLOW_KODA_UNEXPECTED_RESPONSE");
    expect(caught.message).toContain("202");
  });

  test.each([203, 206])("throws FLOW_KODA_UNEXPECTED_RESPONSE for a %i answer", async (status) => {
    stubKoda(() => jsonAnswer({ id: "flow_1", state: "ok", url: "/nax/flows/flow_1" }, status));

    const caught = await rejection(createKodaFlow(connection, body));

    expect(caught.code).toBe("FLOW_KODA_UNEXPECTED_RESPONSE");
    expect(caught.message).toContain(String(status));
  });

  test("rethrows the client's MEMORY_KODA_BAD_RESPONSE when a 2xx carries no JSON body", async () => {
    stubKoda(() => new Response(null, { status: 204 }));

    const caught = await rejection(createKodaFlow(connection, body));

    expect(caught.code).toBe("MEMORY_KODA_BAD_RESPONSE");
  });
});
