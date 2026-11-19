/**
 * flow-handoff.ts — the handoff form of `nax-flow__send`.
 *
 * Driven at the tool's `run`, because that is where the two forms are routed: a body
 * with `handoff` and no `features` never reaches the spec form's parser. The record, the
 * mark and the clock are `_flowHandoffDeps` stubs, and the repository reads, the push and
 * the koda create are `_flowProviderDeps` stubs, so nothing here needs a repository on
 * disk, a remote or a koda server.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { assertDefined, withDepsRestore } from "@test/helpers";
import type { HostApprovalCard } from "@/chat/ask-controller";
import {
  _flowHandoffDeps,
  _flowProviderDeps,
  createFlowProvider,
  type FlowCreateBody,
  type FlowCreateOutcome,
  type FlowHandoffCreateBody,
  type FlowProviderOptions,
  type FlowRepoReady,
  type KodaFlowConnection,
} from "@/chat/flow";
import type { ChainAdmission, ChatChains } from "@/chat/jobs";
import type { ChatChain } from "@/chat/jobs/chain-types";
import { NaxError } from "@/errors";
import type { HandoffMark } from "@/workflow/handoff-mark";
import type { HandoffRecordFile } from "@/workflow/handoff-record";
import { workflowFeatureDir, workflowRunDir } from "@/workflow/paths";

withDepsRestore(_flowProviderDeps);
withDepsRestore(_flowHandoffDeps);

const REPO_ROOT = "/fixture/repo";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const BRANCH = "feat/x";
/** The push destination, as a repository with an SSH `origin` resolves it. */
const PUSH_URL = "git@github.com:o/r.git";
/** The clock the mark's timestamp comes from. */
const AT = new Date("2026-11-18T09:30:00.000Z");
const FEATURE = "f1";
/** The newest run the collected record came from, which is the run the mark belongs to. */
const NEWEST_RUN_ID = "r2";

const connection: KodaFlowConnection = {
  url: "https://koda.example/api",
  headers: { Authorization: "Bearer k" },
};

/** The record a handoff uploads: two run ids, so the card's own run count is testable. */
const record: readonly HandoffRecordFile[] = [
  { runId: NEWEST_RUN_ID, file: "result.json", mtimeMs: 2, content: '{"step":"done"}' },
  { runId: NEWEST_RUN_ID, file: "ledger.md", mtimeMs: 2, content: "ledger" },
  { runId: "r1", file: "result.json", mtimeMs: 1, content: '{"step":"done"}' },
];
/** The record's UTF-8 size, which the card states and koda's own cap measures. */
const RECORD_BYTES = record.reduce((total, entry) => total + Buffer.byteLength(entry.content, "utf8"), 0);

/** The request the brief uses: one already-run feature, the two roles and the cap. */
const handoffInput = {
  handoff: { feature: FEATURE },
  roles: { reviewer: "acp:codex", supervisor: "acp:claude" },
  costCapUsd: 5,
};

/** The spec form's own request, which must keep its behaviour (AC-18). */
const specInput = {
  features: [{ feature: FEATURE, specPath: ".nax/features/f1/spec.md" }],
  roles: { reviewer: "acp:codex", supervisor: "acp:claude" },
  costCapUsd: 5,
};

/** The results the spec form already returns, which a handoff must return unchanged too. */
const DECLINED =
  "[chat] the user declined sending the flow to koda; do not retry with different arguments unless the user asks";
const BRANCH_CHANGED = "[chat] the branch changed while the card was open; nothing was pushed";
const CANCELLED_NOTHING_PUSHED = "[chat] the turn was cancelled; nothing was pushed";

interface PushCall {
  readonly branch: string;
  readonly opts: Parameters<(typeof _flowProviderDeps)["commitAndPush"]>[3];
}

interface KodaCall {
  readonly connection: KodaFlowConnection;
  readonly body: FlowCreateBody | FlowHandoffCreateBody;
}

interface MarkCall {
  readonly runDir: string;
  readonly mark: HandoffMark;
}

interface CollectCall {
  readonly repoRoot: string;
  readonly feature: string;
  readonly head: string;
  readonly branch: string;
}

let approveCalls: HostApprovalCard[];
/** What the host answers the card with; a test replaces it to deny or to abort. */
let reply: (card: HostApprovalCard) => Promise<"allow" | "deny">;
let pushCalls: PushCall[];
let kodaCalls: KodaCall[];
let markCalls: MarkCall[];
let collectCalls: CollectCall[];
/** The spec paths each repository read resolved, so the empty list a handoff passes is assertable. */
let repoReads: (readonly string[])[];
let options: FlowProviderOptions;

/** A repository state a handoff may push from. */
function ready(branch = BRANCH, sha = SHA, remoteUrl = "https://github.com/o/r"): FlowRepoReady {
  return { ok: true, branch, sha, remoteUrl };
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

/** Run the provider's `send` tool with `request`. */
async function send(request: Record<string, unknown>, signal?: AbortSignal) {
  const tool = (await createFlowProvider(options).tools(REPO_ROOT))[0];
  assertDefined(tool, "the nax-flow provider's send tool");
  return await tool.run(request, context(signal));
}

/** A koda error the create rejects with, as the memory client raises it. */
function kodaError(code: string, message: string): NaxError {
  return new NaxError(message, code, { stage: "memory" });
}

/** The body koda was sent, which a spec-form test asserts against. */
function sentBody(index = 0): FlowCreateBody | FlowHandoffCreateBody {
  const call = kodaCalls[index];
  assertDefined(call, `koda create call ${index}`);
  return call.body;
}

beforeEach(() => {
  approveCalls = [];
  pushCalls = [];
  kodaCalls = [];
  markCalls = [];
  collectCalls = [];
  repoReads = [];
  reply = async () => "allow";
  _flowProviderDeps.readFlowRepoState = async (_repoRoot, specPaths) => {
    repoReads.push(specPaths);
    return ready();
  };
  _flowProviderDeps.readFlowPushUrl = async () => ({ ok: true, url: PUSH_URL });
  _flowProviderDeps.headSha = async () => SHA;
  _flowProviderDeps.isDirty = async () => false;
  _flowProviderDeps.commitAndPush = async (_repoRoot, branch, _message, opts) => {
    pushCalls.push({ branch, opts });
    return { committed: false, pushed: true };
  };
  _flowProviderDeps.createKodaFlow = async (sentConnection, body) => {
    kodaCalls.push({ connection: sentConnection, body });
    return { kind: "created", id: "fl1", state: "PENDING", url: "/flows/fl1" };
  };
  _flowHandoffDeps.collectHandoffRecord = async (input) => {
    collectCalls.push(input);
    return { ok: true, record, newestRunId: NEWEST_RUN_ID };
  };
  _flowHandoffDeps.readNewestHandoffMark = async () => null;
  _flowHandoffDeps.readRunMark = async () => null;
  _flowHandoffDeps.writeHandoffMark = async (runDir, mark) => {
    markCalls.push({ runDir, mark });
  };
  _flowHandoffDeps.acquireLock = async () => ({ acquired: true });
  _flowHandoffDeps.releaseLock = async () => {};
  _flowHandoffDeps.now = () => AT;
  options = {
    repoRoot: REPO_ROOT,
    connection,
    approve: async (card) => {
      approveCalls.push(card);
      return await reply(card);
    },
  };
});

function observeChain(admission: ChainAdmission, chain?: ChatChain) {
  const admit = mock<ChatChains["admit"]>(() => admission);
  const stepEnded = mock(() => {});
  const stop = mock(() => undefined);
  const chains = {
    admit,
    stepEnded,
    stop,
    active: () => chain,
    summary: () =>
      chain ? { ...chain, next: 2, spent: 0, steps: chain.steps.map((step, i) => ({ ...step, step: i + 1 })) } : null,
    activate: async () => {
      throw new Error("unexpected activation");
    },
    started: () => {},
    startFailed: () => {},
    isActive: (id) => chain?.id === id || (admission.kind === "auto" && admission.chainId === id),
    recordCheck: () => ({ ok: true }),
    dispose: () => {},
  } satisfies ChatChains;
  options = { ...options, chains };
  return { admit, stepEnded, stop };
}

const AUTO = { kind: "auto", chainId: "chain-12345678", step: 2, approvedAt: AT.toISOString() } as const;
const ACTIVE: ChatChain = {
  schemaVersion: 1,
  id: AUTO.chainId,
  sessionId: "chat-1",
  cwd: REPO_ROOT,
  approvedAt: AUTO.approvedAt,
  state: "active",
  steps: [
    { kind: "run", argv: [], target: FEATURE },
    { kind: "handoff", argv: [], target: FEATURE },
  ],
};

describe("nax-flow__send — chain handoff", () => {
  test("US-008 AC-10 ends the admitted step exactly once on an unclassified throw", async () => {
    const { stepEnded } = observeChain(AUTO);
    _flowProviderDeps.createKodaFlow = async () => {
      throw new Error("boom");
    };

    const result = await send(handoffInput);

    expect(result).toEqual({ isError: true, content: "[chat] flow send failed: boom" });
    expect(stepEnded).toHaveBeenCalledTimes(1);
    expect(stepEnded).toHaveBeenCalledWith(
      AUTO.chainId,
      AUTO.step,
      "failed",
      expect.stringContaining("flow send failed: boom"),
    );
  });

  test("US-008 AC-11 asks for a direct card without ending or stopping an idle chain", async () => {
    const { admit, stepEnded, stop } = observeChain({ kind: "card" });

    expect((await send(handoffInput)).isError).not.toBe(true);
    expect(admit).toHaveBeenCalledTimes(1);
    expect(approveCalls).toHaveLength(1);
    expect(stepEnded).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  test("US-008 AC-14 ends failed but marks an unknown outcome after pushing", async () => {
    const { stepEnded } = observeChain(AUTO);
    _flowProviderDeps.createKodaFlow = async () => {
      throw kodaError("MEMORY_KODA_TIMEOUT", "timed out");
    };
    const result = await send(handoffInput);

    expect(result).toEqual({
      isError: true,
      content: `[chat] koda could not be reached: timed out; branch ${BRANCH} stays pushed and the create's outcome is unknown — check koda for the flow before retrying, because a retry can create a duplicate`,
    });
    expect(pushCalls).toHaveLength(1);
    expect(markCalls).toEqual([
      {
        runDir: workflowRunDir(REPO_ROOT, FEATURE, NEWEST_RUN_ID),
        mark: { schemaVersion: 1, at: AT.toISOString(), outcomeUnknown: true },
      },
    ]);
    expect(stepEnded).toHaveBeenCalledTimes(1);
    expect(stepEnded).toHaveBeenCalledWith(AUTO.chainId, AUTO.step, "failed", result.content);
  });

  test.each(["cancelled", "branch moved"])(
    "US-008 AC-15 ends failed when %s before push without marking",
    async (caseName) => {
      const { stepEnded } = observeChain(AUTO);
      const cancelled = caseName === "cancelled";
      if (!cancelled) _flowProviderDeps.headSha = async () => OTHER_SHA;
      const result = await send(handoffInput, cancelled ? AbortSignal.abort() : undefined);

      expect(result).toEqual({ isError: true, content: cancelled ? CANCELLED_NOTHING_PUSHED : BRANCH_CHANGED });
      expect(pushCalls).toHaveLength(0);
      expect(kodaCalls).toHaveLength(0);
      expect(markCalls).toHaveLength(0);
      expect(stepEnded).toHaveBeenCalledTimes(1);
      expect(stepEnded).toHaveBeenCalledWith(AUTO.chainId, AUTO.step, "failed", result.content);
    },
  );

  test.each(["created", "held"])("US-008 AC-16 ends succeeded if writing the %s mark fails", async (kind) => {
    const { stepEnded } = observeChain(AUTO);
    if (kind === "held") _flowProviderDeps.createKodaFlow = async () => ({ kind: "held", requestId: "rq1" });
    _flowHandoffDeps.writeHandoffMark = async () => {
      throw new Error("EACCES");
    };
    const result = await send(handoffInput);

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain(kind === "held" ? "request rq1" : '"flow":"fl1"');
    expect(result.content).toContain(
      "; the local handoff mark could not be written (EACCES), so nothing stops a local publish of f1",
    );
    expect(stepEnded).toHaveBeenCalledTimes(1);
    expect(stepEnded).toHaveBeenCalledWith(AUTO.chainId, AUTO.step, "succeeded", result.content);
  });

  test.each(["parse", "repo", "branch", "mark", "throw"])(
    "stops a matching next handoff on a %s refusal before admission",
    async (stage) => {
      const { admit, stepEnded, stop } = observeChain(AUTO, ACTIVE);
      if (stage === "repo") _flowProviderDeps.readFlowRepoState = async () => ({ ok: false, message: "[chat] dirty" });
      if (stage === "branch") _flowProviderDeps.readFlowRepoState = async () => ready("not a valid branch");
      if (stage === "mark")
        _flowHandoffDeps.readNewestHandoffMark = async () => ({
          mark: { schemaVersion: 1, at: AT.toISOString(), requestId: "rq1" },
          path: "/r/handoff.json",
        });
      // A thrown local check is a refusal the chain must see too, not an escape past it.
      if (stage === "throw") {
        _flowHandoffDeps.collectHandoffRecord = async () => {
          throw new Error("ELOOP");
        };
      }
      const result = await send(stage === "parse" ? { ...handoffInput, costCapUsd: 0 } : handoffInput);

      expect(result.isError).toBe(true);
      if (stage === "throw") expect(result.content).toBe("[chat] flow send failed: ELOOP");
      expect(stop).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledWith(result.content.replace(/^\[chat\] /, ""));
      expect(admit).not.toHaveBeenCalled();
      expect(stepEnded).not.toHaveBeenCalled();
      expect(approveCalls).toHaveLength(0);
    },
  );

  test("stops a matching next handoff on a request carrying both forms", async () => {
    const { admit, stepEnded, stop } = observeChain(AUTO, ACTIVE);

    const result = await send({ ...handoffInput, features: [] });

    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      "[chat] the flow request is invalid:\n- exactly one of features or handoff is required",
    );
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith(result.content.replace(/^\[chat\] /, ""));
    expect(admit).not.toHaveBeenCalled();
    expect(stepEnded).not.toHaveBeenCalled();
    expect(pushCalls).toHaveLength(0);
  });

  test("does not stop an unrelated next handoff on a refusal", async () => {
    const { admit, stop } = observeChain(AUTO, ACTIVE);
    const result = await send({ ...handoffInput, handoff: { feature: "f2" }, costCapUsd: 0 });
    expect(result.isError).toBe(true);
    expect(admit).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  test("spec sends still ask for a card without consulting chain admission", async () => {
    const { admit, stepEnded, stop } = observeChain(AUTO, ACTIVE);
    expect((await send(specInput)).isError).not.toBe(true);
    expect(approveCalls).toHaveLength(1);
    expect(admit).not.toHaveBeenCalled();
    expect(stepEnded).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });
});

describe("nax-flow__send — the handoff form before the card", () => {
  test("returns the record refusal and touches neither git nor koda (AC-1)", async () => {
    _flowHandoffDeps.collectHandoffRecord = async () => ({ ok: false, reason: "R" });

    const result = await send(handoffInput);

    expect(result).toEqual({ isError: true, content: "[chat] cannot hand off f1: R" });
    expect(approveCalls).toHaveLength(0);
    expect(pushCalls).toHaveLength(0);
    expect(kodaCalls).toHaveLength(0);
    expect(markCalls).toHaveLength(0);
  });

  test("collects the record at the head and branch the repository read reported (AC-2)", async () => {
    _flowProviderDeps.readFlowRepoState = async (_repoRoot, specPaths) => {
      repoReads.push(specPaths);
      return ready("feat/handoff", OTHER_SHA);
    };

    await send(handoffInput);

    // The pre-check and the post-approval re-check read the same record, at the carded head and branch.
    expect(collectCalls).toHaveLength(2);
    expect(collectCalls).toEqual(
      collectCalls.map(() => ({ repoRoot: REPO_ROOT, feature: FEATURE, head: OTHER_SHA, branch: "feat/handoff" })),
    );
    // The repository read resolves no spec paths: a handoff sends none.
    expect(repoReads[0]).toEqual([]);
  });

  test("refuses a feature whose newest run already carries a mark (AC-3)", async () => {
    _flowHandoffDeps.readNewestHandoffMark = async () => ({
      mark: { schemaVersion: 1, at: "T", flowId: "fl1", url: "https://koda/flows/fl1" },
      path: "/r/handoff.json",
    });

    const result = await send(handoffInput);

    expect(result.isError).toBe(true);
    expect(result.content.startsWith("[chat] f1 was handed off to koda")).toBe(true);
    expect(result.content).toContain("/r/handoff.json");
    expect(approveCalls).toHaveLength(0);
    expect(pushCalls).toHaveLength(0);
  });

  test("reads the mark before the card, again before the push, and on the run at the push boundary (AC-3)", async () => {
    const dirs: string[] = [];
    const runDirs: string[] = [];
    _flowHandoffDeps.readNewestHandoffMark = async (dir) => {
      dirs.push(dir);
      return null;
    };
    _flowHandoffDeps.readRunMark = async (runDir) => {
      runDirs.push(runDir);
      return null;
    };

    await send(handoffInput);

    // Once before the card and once after it, both on the feature's own workflow directory...
    const featureDir = workflowFeatureDir(REPO_ROOT, FEATURE);
    expect(dirs).toEqual([featureDir, featureDir]);
    // ...and once on the run this send is about to mark, at the push boundary.
    expect(runDirs).toEqual([workflowRunDir(REPO_ROOT, FEATURE, NEWEST_RUN_ID)]);
  });
});

describe("nax-flow__send — the handoff card", () => {
  test("asks one card, naming the handoff (AC-4)", async () => {
    await send(handoffInput);

    expect(approveCalls).toHaveLength(1);
    const card = approveCalls[0];
    assertDefined(card, "the approval card");
    expect(card.tool).toBe("nax-flow__send");
    expect(card.summary).toBe("hand f1 over to koda");
  });

  test("states the push, the record, the roles, the cap and koda's own approval (AC-5)", async () => {
    await send(handoffInput);

    const card = approveCalls[0];
    assertDefined(card, "the approval card");
    expect(card.command).toBe("git push --set-upstream origin feat/x");
    expect(card.reason).toBe(
      [
        "repo https://github.com/o/r on branch feat/x at 01234567",
        `feature f1: 2 run(s), ${RECORD_BYTES} bytes of run record`,
        "reviewer acp:codex, supervisor acp:claude",
        "cost cap $5.00",
        "koda will ask you to approve this flow before anything billed starts",
      ].join("\n"),
    );
  });

  test("carries the tool run's own abort signal (AC-4)", async () => {
    const controller = new AbortController();

    await send(handoffInput, controller.signal);

    const card = approveCalls[0];
    assertDefined(card, "the approval card");
    expect(card.signal).toBe(controller.signal);
  });

  test("returns the declined result and pushes nothing when the card is denied (AC-6)", async () => {
    reply = async () => "deny";

    const result = await send(handoffInput);

    expect(result).toEqual({ isError: true, content: DECLINED });
    expect(pushCalls).toHaveLength(0);
    expect(kodaCalls).toHaveLength(0);
    expect(markCalls).toHaveLength(0);
  });
});

describe("nax-flow__send — the handoff push and create", () => {
  test("pushes the carded commit without committing (AC-7)", async () => {
    await send(handoffInput);

    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0]?.branch).toBe(BRANCH);
    expect(pushCalls[0]?.opts).toMatchObject({ skipCommit: true, sourceSha: SHA, remote: PUSH_URL });
  });

  test("sends the handoff body, with the record and no spec-form key (AC-8)", async () => {
    await send(handoffInput);

    expect(kodaCalls).toHaveLength(1);
    const body = sentBody();
    expect(body).toEqual({
      remoteUrl: "https://github.com/o/r",
      branch: BRANCH,
      roles: { reviewer: "acp:codex", supervisor: "acp:claude" },
      costCapUsd: 5,
      handoff: { feature: FEATURE, headSha: SHA, record },
    });
    expect(Object.hasOwn(body, "features")).toBe(false);
    expect(Object.hasOwn(body, "specSha")).toBe(false);
  });

  test("reports koda's created flow on the first line (AC-9)", async () => {
    const result = await send(handoffInput);

    expect(result.isError).toBeUndefined();
    expect(result.content.split("\n")[0]).toBe(
      '{"flow":"fl1","state":"PENDING","url":"https://koda.example/flows/fl1"}',
    );
  });

  test("leaves a spec-form body on the spec form, with its specSha and features (AC-18)", async () => {
    await send(specInput);

    expect(collectCalls).toHaveLength(0);
    const body = sentBody();
    expect(Object.hasOwn(body, "specSha")).toBe(true);
    expect(body).toEqual({
      remoteUrl: "https://github.com/o/r",
      branch: BRANCH,
      specSha: SHA,
      features: [{ feature: FEATURE, specPath: ".nax/features/f1/spec.md", dependsOn: [] }],
      roles: { reviewer: "acp:codex", supervisor: "acp:claude" },
      costCapUsd: 5,
    });
    expect(markCalls).toHaveLength(0);
  });
});

describe("nax-flow__send — the mark a handoff leaves", () => {
  const newestRunDir = workflowRunDir(REPO_ROOT, FEATURE, NEWEST_RUN_ID);

  test("marks the newest run with the created flow and the joined link (AC-9)", async () => {
    await send(handoffInput);

    expect(markCalls).toEqual([
      {
        runDir: newestRunDir,
        mark: {
          schemaVersion: 1,
          at: "2026-11-18T09:30:00.000Z",
          flowId: "fl1",
          url: "https://koda.example/flows/fl1",
        },
      },
    ]);
  });

  test("marks the newest run with the approval request koda is holding (AC-10)", async () => {
    _flowProviderDeps.createKodaFlow = async (): Promise<FlowCreateOutcome> => ({ kind: "held", requestId: "rq1" });

    const result = await send(handoffInput);

    expect(markCalls).toEqual([
      { runDir: newestRunDir, mark: { schemaVersion: 1, at: "2026-11-18T09:30:00.000Z", requestId: "rq1" } },
    ]);
    expect(result.content).toBe(
      "koda is holding the flow create for approval (request rq1); no flow exists until it is approved, and " +
        "pushing new commits to the branch before then makes koda refuse it.",
    );
  });

  test("reports koda's HTTP refusal and leaves the run unmarked (AC-11)", async () => {
    _flowProviderDeps.createKodaFlow = async () => {
      throw new NaxError("[memory] koda POST /fleet/flows answered 409: duplicate", "MEMORY_KODA_HTTP", {
        stage: "memory",
        status: 409,
      });
    };

    const result = await send(handoffInput);

    expect(result).toEqual({
      isError: true,
      content: `[chat] koda did not create the flow (HTTP 409): duplicate; branch ${BRANCH} stays pushed`,
    });
    expect(markCalls).toHaveLength(0);
  });

  test.each(["MEMORY_KODA_TIMEOUT", "MEMORY_KODA_UNREACHABLE"])(
    "marks the run's outcome unknown after a %s answer (AC-12, AC-19)",
    async (code) => {
      _flowProviderDeps.createKodaFlow = async () => {
        throw kodaError(code, "[memory] koda POST fleet/flows timed out after 30000ms");
      };

      const result = await send(handoffInput);

      expect(markCalls).toEqual([
        { runDir: newestRunDir, mark: { schemaVersion: 1, at: "2026-11-18T09:30:00.000Z", outcomeUnknown: true } },
      ]);
      expect(result.isError).toBe(true);
      expect(result.content.startsWith("[chat] koda could not be reached: ")).toBe(true);
      expect(result.content.endsWith("can create a duplicate")).toBe(true);
    },
  );

  test.each(["FLOW_KODA_UNEXPECTED_RESPONSE", "MEMORY_KODA_BAD_RESPONSE"])(
    "marks the run's outcome unknown after an unusable %s answer (AC-13, AC-20)",
    async (code) => {
      _flowProviderDeps.createKodaFlow = async () => {
        throw kodaError(code, "[chat-flow] koda POST /fleet/flows answered 201 without a flow");
      };

      const result = await send(handoffInput);

      expect(markCalls).toEqual([
        { runDir: newestRunDir, mark: { schemaVersion: 1, at: "2026-11-18T09:30:00.000Z", outcomeUnknown: true } },
      ]);
      expect(result.isError).toBe(true);
      expect(result.content.startsWith("[chat] koda answered unexpectedly: ")).toBe(true);
      expect(result.content.endsWith(`; branch ${BRANCH} stays pushed`)).toBe(true);
    },
  );

  test("marks the run's outcome unknown when the create is cancelled (AC-14)", async () => {
    _flowProviderDeps.createKodaFlow = async () => {
      throw kodaError("MEMORY_KODA_ABORTED", "[memory] koda POST fleet/flows was cancelled before it answered");
    };

    const result = await send(handoffInput, new AbortController().signal);

    expect(markCalls).toEqual([
      { runDir: newestRunDir, mark: { schemaVersion: 1, at: "2026-11-18T09:30:00.000Z", outcomeUnknown: true } },
    ]);
    expect(result.content).toContain("the turn was cancelled during the koda request");
    expect(result.content).toContain(`branch ${BRANCH} stays pushed`);
    expect(result.content).toContain("koda may have created the flow");
  });

  test("appends the write failure to a successful result, which stays a success (AC-17)", async () => {
    _flowHandoffDeps.writeHandoffMark = async () => {
      throw new Error("EACCES");
    };

    const result = await send(handoffInput);

    expect(result.isError).toBeUndefined();
    expect(
      result.content.endsWith(
        "; the local handoff mark could not be written (EACCES), so nothing stops a local publish of f1",
      ),
    ).toBe(true);
    expect(result.content.split("\n")[0]).toBe(
      '{"flow":"fl1","state":"PENDING","url":"https://koda.example/flows/fl1"}',
    );
  });
});
