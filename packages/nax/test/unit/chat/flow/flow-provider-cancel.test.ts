/**
 * flow-provider.ts — the koda create under the turn's own cancellation.
 *
 * An Esc after the push used to leave the flow create running while the chat said
 * nothing was pushed, so koda could create a flow the transcript called abandoned.
 * The create now takes the turn's signal, the send declares a grace long enough for
 * that answer to reach the transcript, and a cancelled create says the branch stays
 * pushed and koda may have created the flow.
 *
 * The harness is `_flowProviderDeps`, as in flow-provider.test.ts: a repository, a
 * remote and a koda server are all stubs.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { assertDefined, withDepsRestore } from "@test/helpers";
import type { HostApprovalCard } from "@/chat/ask-controller";
import {
  _flowProviderDeps,
  createFlowProvider,
  FLOW_SEND_CANCEL_GRACE_MS,
  FLOW_SEND_INPUT_SCHEMA,
  type FlowCreateBody,
  type FlowCreateOutcome,
  type FlowProviderOptions,
  type FlowRepoReady,
  type KodaFlowConnection,
} from "@/chat/flow";
import { NaxError } from "@/errors";

withDepsRestore(_flowProviderDeps, [
  "readFlowRepoState",
  "readFlowPushUrl",
  "headSha",
  "isDirty",
  "commitAndPush",
  "createKodaFlow",
]);

const REPO_ROOT = "/fixture/repo";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const BRANCH = "feat/x";
const PUSH_URL = "git@github.com:o/r.git";

const connection: KodaFlowConnection = {
  url: "https://koda.example/api",
  headers: { Authorization: "Bearer k" },
};

const input = {
  features: [
    { feature: "a", specPath: ".nax/features/a/spec.md" },
    { feature: "b", specPath: ".nax/features/b/spec.md", dependsOn: ["a"] },
  ],
  roles: { reviewer: "acp:codex", supervisor: "acp:claude" },
  costCapUsd: 5,
};

/** The cancelled create's own result, as the brief spells it. */
const CANCELLED_CREATE =
  "[chat] the turn was cancelled during the koda request; branch feat/x stays pushed and koda may have created " +
  "the flow; check koda's flows before sending again (a duplicate send is refused with 409)";

/** The pre-push cancellation's result, unchanged by this story. */
const CANCELLED_NOTHING_PUSHED = "[chat] the turn was cancelled; nothing was pushed";

let approveCalls: HostApprovalCard[];
let pushCalls: number;
/** Every `createKodaFlow` call: its connection, its body and its third argument. */
let kodaCalls: { connection: KodaFlowConnection; body: FlowCreateBody; signal: AbortSignal | undefined }[];
let options: FlowProviderOptions;

/** A repository state a flow may be sent from. */
function ready(): FlowRepoReady {
  return { ok: true, branch: BRANCH, sha: SHA, remoteUrl: "https://github.com/o/r" };
}

/** The tool's run context; `signal` is the turn's cancellation. */
function context(signal?: AbortSignal) {
  return {
    root: REPO_ROOT,
    resolvedPaths: [],
    maxBytes: 300_000,
    maxFileBytes: 300_000,
    ...(signal ? { signal } : {}),
  };
}

/** The provider's `send` tool. */
async function sendTool() {
  const tool = (await createFlowProvider(options).tools(REPO_ROOT))[0];
  assertDefined(tool, "the nax-flow provider's send tool");
  return tool;
}

/** Run the provider's `send` tool with `request` under the turn's `signal`. */
async function send(request: Record<string, unknown>, signal?: AbortSignal) {
  return (await sendTool()).run(request, context(signal));
}

/** The koda `MEMORY_KODA_ABORTED` a cancelled create rejects with. */
function abortedCreate(): NaxError {
  return new NaxError("[memory] koda POST fleet/flows was cancelled before it answered", "MEMORY_KODA_ABORTED", {
    stage: "memory",
    method: "POST",
    path: "fleet/flows",
  });
}

beforeEach(() => {
  approveCalls = [];
  pushCalls = 0;
  kodaCalls = [];
  _flowProviderDeps.readFlowRepoState = async () => ready();
  _flowProviderDeps.readFlowPushUrl = async () => ({ ok: true, url: PUSH_URL });
  _flowProviderDeps.headSha = async () => SHA;
  _flowProviderDeps.isDirty = async () => false;
  _flowProviderDeps.commitAndPush = async () => {
    pushCalls += 1;
    return { committed: false, pushed: true };
  };
  _flowProviderDeps.createKodaFlow = async (sentConnection, body, signal) => {
    kodaCalls.push({ connection: sentConnection, body, signal });
    return { kind: "created", id: "f1", state: "PENDING", url: "/sandbox/flows/f1" };
  };
  options = {
    repoRoot: REPO_ROOT,
    connection,
    approve: async (card) => {
      approveCalls.push(card);
      return "allow";
    },
  };
});

describe("nax-flow__send — the cancel grace", () => {
  test("declares FLOW_SEND_CANCEL_GRACE_MS, which is 5000 ms (AC-7)", async () => {
    expect(FLOW_SEND_CANCEL_GRACE_MS).toBe(5_000);
    expect((await sendTool()).cancelGraceMs).toBe(FLOW_SEND_CANCEL_GRACE_MS);
  });

  test("declares no grace on anything but its one send tool (AC-7)", async () => {
    const tools = await createFlowProvider(options).tools(REPO_ROOT);

    expect(tools.map((tool) => tool.localName)).toEqual(["send"]);
    expect(tools[0]?.inputSchema).toBe(FLOW_SEND_INPUT_SCHEMA);
  });
});

describe("nax-flow__send — the koda create under the turn's signal", () => {
  test("passes the run context's signal as createKodaFlow's third argument (AC-8)", async () => {
    const controller = new AbortController();

    await send(input, controller.signal);

    expect(pushCalls).toBe(1);
    expect(kodaCalls).toHaveLength(1);
    expect(kodaCalls[0]?.signal).toBe(controller.signal);
  });

  test("reports a cancelled create as pushed-but-unknown, naming the branch (AC-9)", async () => {
    _flowProviderDeps.createKodaFlow = async () => {
      throw abortedCreate();
    };

    const result = await send(input, new AbortController().signal);

    // The push succeeded before the create was cancelled, so the result says so.
    expect(pushCalls).toBe(1);
    expect(result).toEqual({ isError: true, content: CANCELLED_CREATE });
    expect(result.content).toContain(`branch ${BRANCH} stays pushed`);
    expect(result.content).toContain("koda may have created the flow");
    expect(result.content).toContain("a duplicate send is refused with 409");
  });

  test("keeps the created-flow answer when the abort lands as the create resolves (AC-10)", async () => {
    const baseline = await send(input);

    const controller = new AbortController();
    _flowProviderDeps.createKodaFlow = async () => {
      const outcome: FlowCreateOutcome = { kind: "created", id: "f1", state: "PENDING", url: "/sandbox/flows/f1" };
      // The answer is in hand; the turn is cancelled on the way back.
      controller.abort();
      return outcome;
    };

    const result = await send(input, controller.signal);

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(baseline.content);
    expect(result.content).not.toContain("the turn was cancelled");
  });

  test("returns the held-create answer when the abort lands as that answer is received (AC-12)", async () => {
    const controller = new AbortController();
    _flowProviderDeps.createKodaFlow = async () => {
      const outcome: FlowCreateOutcome = { kind: "held", requestId: "r1" };
      controller.abort();
      return outcome;
    };

    const result = await send(input, controller.signal);

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("koda is holding the flow create for approval (request r1)");
    expect(result.content).not.toContain("the turn was cancelled during the koda request");
  });

  test("still says nothing was pushed when the push fails on a cancelled turn (AC-11)", async () => {
    const controller = new AbortController();
    _flowProviderDeps.commitAndPush = async () => {
      controller.abort();
      throw new Error('git push of "feat/x" failed: git-remote-https died of signal 9');
    };

    const result = await send(input, controller.signal);

    expect(result).toEqual({ isError: true, content: CANCELLED_NOTHING_PUSHED });
    expect(kodaCalls).toHaveLength(0);
  });
});
