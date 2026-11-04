/**
 * koda-provider-save.test.ts — the koda provider's reachability, its memoised
 * project id and its save delivery.
 *
 * Covers US-005 AC-1..AC-22. Every case drives the provider over a real
 * `createKodaClient` whose `fetch` seam is stubbed, and the proposal case over a
 * real `createKodaApprovals` in a temporary directory — so what is asserted is the
 * requests koda would receive and the record a `202` leaves on disk, not the
 * provider's own view of either.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  isMemoryPushRejected,
  type MemoryNote,
  type MemoryProvider,
  type MemoryWriteRequest,
} from "@nathapp/nax-agent";
import { assertDefined, cleanupTempDir, type MockLogger, makeLogger, makeTempDir } from "@test/helpers";
import { NaxError } from "@/errors";
import { createKodaApprovals, type KodaApproval, type KodaApprovals } from "@/memory/koda-approvals";
import { _kodaClientDeps, createKodaClient, kodaStatusOf } from "@/memory/koda-http";
import {
  type CreateKodaMemoryProviderInput,
  createKodaMemoryProvider,
  MEMORY_KODA_APPROVAL_CHECKS_MAX,
  MEMORY_KODA_PROVIDER_PREFIX,
} from "@/memory/koda-provider";

/** The API root every case builds its client from; koda's global prefix is part of it. */
const API = "https://k.example/api";
/** The koda project slug the provider is composed for. */
const PROJECT = "rs-stock";
/** The koda project id `GET projects/rs-stock` answers with. */
const PROJECT_ID = "p1";
/** The instant every note in this file carries. */
const STAMP = "2026-11-12T10:15:00.000Z";
/** How long a request may run: short, so the never-settling case rejects promptly. */
const CLIENT_TIMEOUT_MS = 50;

/** The note every save carries, as the operations layer stages it. */
const NOTE: MemoryNote = {
  id: "c1",
  slug: "replay-budget",
  type: "project",
  scope: "project",
  description: "replay budget stays 2,048 MiB",
  source: "nax-chat",
  updatedAt: STAMP,
  status: "active",
  body: "The replay budget stays at 2,048 MiB.",
};

/** The save every case pushes unless it says otherwise. */
const SAVE: MemoryWriteRequest = {
  kind: "save",
  clientId: "c1",
  scope: "project",
  slug: "replay-budget",
  writeMode: "direct",
  note: NOTE,
};

/** The nine keys a save's wire body carries, and no others. */
const SAVE_BODY_KEYS = [
  "projectId",
  "kind",
  "subject",
  "predicate",
  "object",
  "description",
  "scope",
  "sourceType",
  "sourceId",
];

/** One recorded request, as the stubbed transport sees it. */
interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

let calls: FetchCall[] = [];
let originalFetch: typeof _kodaClientDeps.fetch;

/** Replace the fetch seam with `answer`, recording every call it receives. */
function stubFetch(answer: (call: FetchCall) => Response | Promise<Response>): void {
  _kodaClientDeps.fetch = async (input, init) => {
    const call: FetchCall = { url: input, init };
    calls.push(call);
    return await answer(call);
  };
}

/** A koda envelope answer. */
function jsonAnswer(body: unknown, status = 200, statusText = ""): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

/** The `GET projects/<slug>` answer, carrying `data`. */
function projectAnswer(data: unknown = { id: PROJECT_ID }): Response {
  return jsonAnswer({ ret: 0, data });
}

/** The `POST memory` answer, carrying `data` at `status`. */
function saveAnswer(data: unknown, status = 201): Response {
  return jsonAnswer({ ret: 0, data }, status);
}

/** Answer the project lookup with `project`, and the save with `answer`. */
function stubSave(answer: () => Response | Promise<Response>, project: () => Response = () => projectAnswer()): void {
  stubFetch((call) => (call.init.method === "POST" ? answer() : project()));
}

/** The requests made so far as `METHOD path` rows, in the order koda received them. */
function routesOf(): readonly string[] {
  return calls.map((call) => `${call.init.method ?? "GET"} ${new URL(call.url).pathname}`);
}

/** The requests made with `method`. */
function callsOf(method: "GET" | "POST"): readonly FetchCall[] {
  return calls.filter((call) => call.init.method === method);
}

/** The parsed body of one recorded request. */
function bodyOf(call: FetchCall | undefined): Record<string, unknown> {
  assertDefined(call, "the recorded request");
  const body: Record<string, unknown> = JSON.parse(String(call.init.body));
  return body;
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

describe("createKodaMemoryProvider — identity", () => {
  let dir: string;
  let logger: MockLogger;
  let approvals: KodaApprovals;

  /** The provider under test, over this case's approvals record and the stubbed transport. */
  function makeProvider(overrides: Partial<CreateKodaMemoryProviderInput> = {}): MemoryProvider {
    return createKodaMemoryProvider({
      client: createKodaClient({ url: API, headers: { Authorization: "Bearer k" }, timeoutMs: CLIENT_TIMEOUT_MS }),
      project: PROJECT,
      approvals,
      readNote: async () => null,
      readDecisions: async () => [],
      logger,
      ...overrides,
    });
  }

  beforeEach(() => {
    originalFetch = _kodaClientDeps.fetch;
    calls = [];
    dir = makeTempDir("nax-koda-provider-");
    logger = makeLogger();
    approvals = createKodaApprovals({ dir: join(dir, "project"), logger });
  });

  afterEach(() => {
    _kodaClientDeps.fetch = originalFetch;
    cleanupTempDir(dir);
  });

  test("its id is the provider prefix and the project slug (AC-1)", () => {
    expect(makeProvider().id).toBe("koda:rs-stock");
  });

  test("the prefix is koda: and the approval budget is 20 (AC-2)", () => {
    expect(MEMORY_KODA_PROVIDER_PREFIX).toBe("koda:");
    expect(MEMORY_KODA_APPROVAL_CHECKS_MAX).toBe(20);
  });

  test("reachable requests the write-mode probe and is true for a proposal answer (AC-3)", async () => {
    stubFetch(() => jsonAnswer({ ret: 0, data: { mode: "proposal" } }));

    expect(await makeProvider().reachable()).toBe(true);
    expect(routesOf()).toEqual(["GET /api/projects/rs-stock/memory/write-mode"]);
  });

  test("reachable is true for a direct answer too", async () => {
    stubFetch(() => jsonAnswer({ ret: 0, data: { mode: "direct" } }));

    expect(await makeProvider().reachable()).toBe(true);
  });

  test("reachable is false when the key is refused (AC-4)", async () => {
    stubFetch(() => jsonAnswer({ ret: -1, message: "unauthorized" }, 401));

    expect(await makeProvider().reachable()).toBe(false);
  });

  test("reachable is false when the answer names no mode (AC-5)", async () => {
    stubFetch(() => jsonAnswer({ ret: 0, data: {} }));

    expect(await makeProvider().reachable()).toBe(false);
  });

  test.each([
    ["koda is unreachable", async (): Promise<Response> => Promise.reject(new TypeError("connection refused"))],
    ["the key is rejected", (): Response => jsonAnswer({ ret: -1, message: "unauthorized" }, 401)],
    ["the project membership is denied", (): Response => jsonAnswer({ ret: -1, message: "forbidden" }, 403)],
    ["the answer never arrives", (): Promise<Response> => new Promise<Response>(() => {})],
  ])("reachable is false when %s (AC-22)", async (_label, answer) => {
    stubFetch(() => answer());

    expect(await makeProvider().reachable()).toBe(false);
  });
});

describe("createKodaMemoryProvider — save delivery", () => {
  let dir: string;
  let logger: MockLogger;
  let approvals: KodaApprovals;

  /** The provider under test, over this case's approvals record and the stubbed transport. */
  function makeProvider(overrides: Partial<CreateKodaMemoryProviderInput> = {}): MemoryProvider {
    return createKodaMemoryProvider({
      client: createKodaClient({ url: API, headers: { Authorization: "Bearer k" }, timeoutMs: CLIENT_TIMEOUT_MS }),
      project: PROJECT,
      approvals,
      readNote: async () => null,
      readDecisions: async () => [],
      logger,
      ...overrides,
    });
  }

  beforeEach(() => {
    originalFetch = _kodaClientDeps.fetch;
    calls = [];
    dir = makeTempDir("nax-koda-provider-");
    logger = makeLogger();
    approvals = createKodaApprovals({ dir: join(dir, "project"), logger });
  });

  afterEach(() => {
    _kodaClientDeps.fetch = originalFetch;
    cleanupTempDir(dir);
  });

  test("a save looks the project up first, then posts the nine-key body (AC-6)", async () => {
    stubSave(() => saveAnswer({ id: "k7" }));

    await makeProvider().push(SAVE);

    expect(routesOf()).toEqual(["GET /api/projects/rs-stock", "POST /api/memory"]);
    expect(bodyOf(callsOf("POST")[0])).toEqual({
      projectId: PROJECT_ID,
      kind: "NOTE",
      subject: "replay-budget",
      predicate: "project",
      object: NOTE.body,
      description: NOTE.description,
      scope: "project",
      sourceType: "nax-chat",
      sourceId: "c1",
    });
  });

  test.each([["direct"], ["proposal"]] as const)(
    "the save body carries exactly the nine keys and no writeMode with writeMode %s (AC-7)",
    async (writeMode) => {
      stubSave(() => saveAnswer({ id: "k7" }));

      await makeProvider().push({ ...SAVE, writeMode });

      const body = bodyOf(callsOf("POST")[0]);
      expect(Object.keys(body).sort()).toEqual([...SAVE_BODY_KEYS].sort());
      expect("writeMode" in body).toBe(false);
    },
  );

  test("a user-scope save sends scope user and the project id (AC-8)", async () => {
    stubSave(() => saveAnswer({ id: "k8" }));
    const userNote: MemoryNote = { ...NOTE, id: "c9", scope: "user", type: "user", slug: "staging-creds" };

    await makeProvider().push({
      ...SAVE,
      clientId: "c9",
      scope: "user",
      slug: "staging-creds",
      note: userNote,
    });

    const body = bodyOf(callsOf("POST")[0]);
    expect(body.scope).toBe("user");
    expect(body.projectId).toBe(PROJECT_ID);
    expect(body.subject).toBe("staging-creds");
    expect(body.predicate).toBe("user");
  });

  test("two saves look the project up once (AC-9)", async () => {
    stubSave(() => saveAnswer({ id: "k7" }));
    const provider = makeProvider();
    const second: MemoryNote = { ...NOTE, id: "c2", slug: "export-window" };

    await provider.push(SAVE);
    await provider.push({ ...SAVE, clientId: "c2", slug: "export-window", note: second });

    expect(callsOf("GET")).toHaveLength(1);
    expect(callsOf("POST")).toHaveLength(2);
  });

  test("a project answer without a string id is a bad response and is not memoised (AC-10)", async () => {
    const projectAnswers = [projectAnswer({ id: 7 }), projectAnswer()];
    stubSave(
      () => saveAnswer({ id: "k7" }),
      () => projectAnswers.shift() ?? projectAnswer(),
    );
    const provider = makeProvider();

    const error = await rejection(provider.push(SAVE));
    expect(error.code).toBe("MEMORY_KODA_BAD_RESPONSE");
    expect(routesOf()).toEqual(["GET /api/projects/rs-stock"]);

    await expect(provider.push(SAVE)).resolves.toEqual({ id: "k7", status: "active" });
    expect(callsOf("GET")).toHaveLength(2);
  });

  test("a 201 answer resolves the koda id as active (AC-11)", async () => {
    stubSave(() => saveAnswer({ id: "k7" }, 201));

    expect(await makeProvider().push(SAVE)).toEqual({ id: "k7", status: "active" });
  });

  test("a 202 answer resolves the client id as pending (AC-12)", async () => {
    stubSave(() => saveAnswer({ id: "apr_1" }, 202));

    expect(await makeProvider().push(SAVE)).toEqual({ id: "c1", status: "pending" });
  });

  test("a 202 answer records the approval it opened, on disk (AC-13)", async () => {
    stubSave(() => saveAnswer({ id: "apr_1" }, 202));

    await makeProvider().push(SAVE);

    const recorded: readonly KodaApproval[] = [
      { approvalId: "apr_1", scope: "project", slug: "replay-budget", clientId: "c1" },
    ];
    expect(await approvals.list()).toEqual(recorded);
    expect(await createKodaApprovals({ dir: join(dir, "project"), logger }).list()).toEqual(recorded);
  });

  test("a project answer carrying no data is a bad response, not a save", async () => {
    stubSave(
      () => saveAnswer({ id: "k7" }),
      () => jsonAnswer({ ret: 0 }),
    );

    const error = await rejection(makeProvider().push(SAVE));

    expect(error.code).toBe("MEMORY_KODA_BAD_RESPONSE");
    expect(callsOf("POST")).toHaveLength(0);
  });

  test("a save that carries no note is refused, so the outbox stops retrying it", async () => {
    const noteLess: MemoryWriteRequest = {
      kind: "save",
      clientId: "c4",
      scope: "project",
      slug: "replay-budget",
      writeMode: "direct",
    };

    const error = await rejection(makeProvider().push(noteLess));

    expect(error.code).toBe("MEMORY_PUSH_REJECTED");
    expect(routesOf()).toEqual([]);
  });
});

describe("createKodaMemoryProvider — refusals and transient failures", () => {
  let dir: string;
  let logger: MockLogger;
  let approvals: KodaApprovals;

  /** The provider under test, over this case's approvals record and the stubbed transport. */
  function makeProvider(overrides: Partial<CreateKodaMemoryProviderInput> = {}): MemoryProvider {
    return createKodaMemoryProvider({
      client: createKodaClient({ url: API, headers: { Authorization: "Bearer k" }, timeoutMs: CLIENT_TIMEOUT_MS }),
      project: PROJECT,
      approvals,
      readNote: async () => null,
      readDecisions: async () => [],
      logger,
      ...overrides,
    });
  }

  /** A save refused by koda with `status` and `message`. */
  function refused(status: number, message = "kind is not a NOTE"): Response {
    return jsonAnswer({ ret: -2, message }, status);
  }

  beforeEach(() => {
    originalFetch = _kodaClientDeps.fetch;
    calls = [];
    dir = makeTempDir("nax-koda-provider-");
    logger = makeLogger();
    approvals = createKodaApprovals({ dir: join(dir, "project"), logger });
  });

  afterEach(() => {
    _kodaClientDeps.fetch = originalFetch;
    cleanupTempDir(dir);
  });

  test("a 422 is a permanent refusal quoting koda's message (AC-14)", async () => {
    stubSave(() => refused(422, "description is required"));

    const error = await rejection(makeProvider().push(SAVE));

    expect(isMemoryPushRejected(error)).toBe(true);
    expect(error.message).toContain("description is required");
  });

  test.each([400, 413, 422])("a %d is a permanent refusal quoting koda's message (AC-20)", async (status) => {
    stubSave(() => refused(status, "object is required"));

    const error = await rejection(makeProvider().push(SAVE));

    expect(error.code).toBe("MEMORY_PUSH_REJECTED");
    expect(error.message).toContain("object is required");
  });

  test.each([
    ["the principal may not create a note", 403],
    ["the slug is already taken by another principal", 409],
  ])("a save refused with %s is permanent (AC-15, AC-16)", async (_label, status) => {
    stubSave(() => refused(status));

    expect(isMemoryPushRejected(await rejection(makeProvider().push(SAVE)))).toBe(true);
  });

  test.each([
    ["the key is rejected", 401],
    ["the project is not found", 404],
    ["the service is unavailable", 503],
  ])("a save answered %s is transient (AC-17, AC-18, AC-19)", async (_label, status) => {
    stubSave(() => refused(status));

    const error = await rejection(makeProvider().push(SAVE));

    expect(isMemoryPushRejected(error)).toBe(false);
    expect(kodaStatusOf(error)).toBe(status);
  });

  test.each([
    ["a 408", (): Response => refused(408, "request timeout")],
    ["a 429", (): Response => refused(429, "slow down")],
    ["a 500", (): Response => refused(500, "boom")],
    ["a 502", (): Response => refused(502, "bad gateway")],
    ["an answer that never arrives", (): Promise<Response> => new Promise<Response>(() => {})],
    ["an unreachable host", (): Promise<Response> => Promise.reject(new TypeError("connection refused"))],
    ["a 201 whose body is not JSON", (): Response => new Response("not json", { status: 201, statusText: "Created" })],
  ])("a save answered with %s is transient, not a refusal (AC-21)", async (_label, answer) => {
    stubSave(() => answer());

    const error = await rejection(makeProvider().push(SAVE));

    expect(isMemoryPushRejected(error)).toBe(false);
    expect(error).toBeInstanceOf(NaxError);
  });

  test("a 202 without an approval id is a bad response, not a recorded proposal", async () => {
    stubSave(() => jsonAnswer({ ret: 0, data: {} }, 202));

    const error = await rejection(makeProvider().push(SAVE));

    expect(error.code).toBe("MEMORY_KODA_BAD_RESPONSE");
    expect(await approvals.list()).toEqual([]);
  });
});
