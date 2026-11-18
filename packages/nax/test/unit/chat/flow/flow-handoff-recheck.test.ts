/**
 * flow-handoff.ts — what a handoff checks after the card, and what a cancelled turn answers.
 *
 * The card opens a window: the user may take minutes over it, another handoff of the same feature may
 * finish inside it, and the turn may be cancelled. Everything that closes that window lives here — the
 * record and the mark re-read after the allow, the mark read again on the run the send will mark at the
 * push boundary, the serialization of one feature's handoffs, and the cancellation that must answer with
 * the cancel rather than with whatever an interrupted read found.
 *
 * The harness is the one `flow-handoff.test.ts` drives — the record, the mark and the clock on
 * `_flowHandoffDeps`, the repository, the push and the koda create on `_flowProviderDeps` — trimmed to
 * what a post-approval test reads.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { assertDefined, withDepsRestore } from "@test/helpers";
import type { HostApprovalCard } from "@/chat/ask-controller";
import {
  _flowHandoffDeps,
  _flowProviderDeps,
  createFlowProvider,
  type FlowCreateBody,
  type FlowHandoffCreateBody,
  type FlowProviderOptions,
  type FlowRepoReady,
  type KodaFlowConnection,
} from "@/chat/flow";
import type { FoundHandoffMark, HandoffMark } from "@/workflow/handoff-mark";
import type { HandoffRecordFile } from "@/workflow/handoff-record";
import { workflowRunDir } from "@/workflow/paths";

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

/** The record the card approved: two run ids, so a run appearing beside them is visible. */
const record: readonly HandoffRecordFile[] = [
  { runId: NEWEST_RUN_ID, file: "result.json", mtimeMs: 2, content: '{"step":"done"}' },
  { runId: NEWEST_RUN_ID, file: "ledger.md", mtimeMs: 2, content: "ledger" },
  { runId: "r1", file: "result.json", mtimeMs: 1, content: '{"step":"done"}' },
];

/** The request the brief uses: one already-run feature, the two roles and the cap. */
const handoffInput = {
  handoff: { feature: FEATURE },
  roles: { reviewer: "acp:codex", supervisor: "acp:claude" },
  costCapUsd: 5,
};

const RECORD_CHANGED = "[chat] the run record changed while the card was open; nothing was pushed";
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
/** What the host answers the card with; a test replaces it to deny, to change the disk, or to abort. */
let reply: (card: HostApprovalCard) => Promise<"allow" | "deny">;
let pushCalls: PushCall[];
let kodaCalls: KodaCall[];
let markCalls: MarkCall[];
let collectCalls: CollectCall[];
let options: FlowProviderOptions;

/** A repository state a handoff may push from. */
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

/** Run the provider's `send` tool with `request`. */
async function send(request: Record<string, unknown>, signal?: AbortSignal) {
  const tool = (await createFlowProvider(options).tools(REPO_ROOT))[0];
  assertDefined(tool, "the nax-flow provider's send tool");
  return await tool.run(request, context(signal));
}

beforeEach(() => {
  approveCalls = [];
  pushCalls = [];
  kodaCalls = [];
  markCalls = [];
  collectCalls = [];
  reply = async () => "allow";
  _flowProviderDeps.readFlowRepoState = async () => ready();
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

describe("nax-flow__send — the record is re-checked after approval", () => {
  const MARK: HandoffMark = { schemaVersion: 1, at: "T", flowId: "fl9", url: "https://koda/flows/fl9" };

  /** Answer the card by changing what is on disk, then allowing it. */
  function allowAfter(change: () => void): void {
    reply = async () => {
      change();
      return "allow";
    };
  }

  test("refuses a mark that appeared while the card was open, pushing nothing (AC-3)", async () => {
    allowAfter(() => {
      _flowHandoffDeps.readNewestHandoffMark = async () => ({ mark: MARK, path: "/r/handoff.json" });
    });

    const result = await send(handoffInput);

    expect(result.isError).toBe(true);
    expect(result.content.startsWith("[chat] f1 was handed off to koda (flow fl9")).toBe(true);
    expect(result.content).toContain("/r/handoff.json");
    expect(pushCalls).toHaveLength(0);
    expect(kodaCalls).toHaveLength(0);
    expect(markCalls).toHaveLength(0);
  });

  test("refuses a newer run at the same commit, so no mark lands on a run the guards do not read", async () => {
    allowAfter(() => {
      _flowHandoffDeps.collectHandoffRecord = async () => ({
        ok: true,
        record: [{ runId: "r3", file: "result.json", mtimeMs: 3, content: '{"step":"done"}' }],
        newestRunId: "r3",
      });
    });

    const result = await send(handoffInput);

    expect(result).toEqual({ isError: true, content: RECORD_CHANGED });
    expect(pushCalls).toHaveLength(0);
    expect(kodaCalls).toHaveLength(0);
    expect(markCalls).toHaveLength(0);
  });

  test("refuses a record whose text changed while the card was open", async () => {
    allowAfter(() => {
      _flowHandoffDeps.collectHandoffRecord = async () => ({
        ok: true,
        record: record.map((entry) =>
          entry.file === "ledger.md" ? { ...entry, content: "edited while the card was open" } : entry,
        ),
        newestRunId: NEWEST_RUN_ID,
      });
    });

    const result = await send(handoffInput);

    expect(result.content).toBe(RECORD_CHANGED);
    expect(pushCalls).toHaveLength(0);
    expect(markCalls).toHaveLength(0);
  });

  test("refuses a record the re-check can no longer read", async () => {
    allowAfter(() => {
      _flowHandoffDeps.collectHandoffRecord = async () => ({ ok: false, reason: "the run moved" });
    });

    const result = await send(handoffInput);

    expect(result).toEqual({ isError: true, content: "[chat] cannot hand off f1: the run moved" });
    expect(pushCalls).toHaveLength(0);
    expect(kodaCalls).toHaveLength(0);
  });
});

describe("nax-flow__send — the mark is read again at the push boundary", () => {
  const MARK: HandoffMark = { schemaVersion: 1, at: "T", flowId: "fl9", url: "https://koda/flows/fl9" };

  test("refuses a mark another handoff wrote on the verified run while the checks ran, pushing nothing", async () => {
    // The re-check's own mark read answered nothing; the run has one by the time the push would go.
    _flowHandoffDeps.readRunMark = async (runDir) => ({ mark: MARK, path: `${runDir}/handoff.json` });

    const result = await send(handoffInput);

    expect(result.isError).toBe(true);
    expect(result.content.startsWith("[chat] f1 was handed off to koda (flow fl9")).toBe(true);
    expect(result.content).toContain(`${workflowRunDir(REPO_ROOT, FEATURE, NEWEST_RUN_ID)}/handoff.json`);
    expect(pushCalls).toHaveLength(0);
    expect(kodaCalls).toHaveLength(0);
    expect(markCalls).toHaveLength(0);
  });

  test("serializes two handoffs of one feature, so only the first pushes and marks", async () => {
    // One run directory, one mark: what the first send writes is what every later check reads.
    let marked: FoundHandoffMark | null = null;
    _flowHandoffDeps.readNewestHandoffMark = async () => marked;
    _flowHandoffDeps.readRunMark = async () => marked;
    _flowHandoffDeps.writeHandoffMark = async (runDir, mark) => {
      markCalls.push({ runDir, mark });
      marked = { mark, path: `${runDir}/handoff.json` };
    };
    // Hold the first send inside the push, so the second one has every chance to overtake it.
    const atPush = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    _flowProviderDeps.commitAndPush = async (_repoRoot, branch, _message, opts) => {
      pushCalls.push({ branch, opts });
      atPush.resolve();
      await held.promise;
      return { committed: false, pushed: true };
    };

    const first = send(handoffInput);
    const second = send(handoffInput);
    await atPush.promise;
    await Bun.sleep(20);
    held.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(pushCalls).toHaveLength(1);
    expect(kodaCalls).toHaveLength(1);
    expect(markCalls).toHaveLength(1);
    expect(firstResult.isError).not.toBe(true);
    expect(secondResult.isError).toBe(true);
    expect(secondResult.content.startsWith("[chat] f1 was handed off to koda")).toBe(true);
  });
});

describe("nax-flow__send — a cancelled turn answers with the cancel", () => {
  /** Allow the card and cancel the turn at that instant, as an Esc past the card does. */
  function allowThenCancel(controller: AbortController): void {
    reply = async () => {
      controller.abort();
      return "allow";
    };
  }

  /** The pre-card read answers the record; every later read is the one under test. */
  function recordOnceThen(interrupt: () => { readonly ok: false; readonly reason: string }): void {
    _flowHandoffDeps.collectHandoffRecord = async (input) => {
      collectCalls.push(input);
      if (collectCalls.length === 1) return { ok: true, record, newestRunId: NEWEST_RUN_ID };
      return interrupt();
    };
  }

  test("does not re-read the record of a turn already cancelled after the card (AC-15)", async () => {
    const controller = new AbortController();
    allowThenCancel(controller);
    recordOnceThen(() => ({ ok: false, reason: "the run moved" }));

    const result = await send(handoffInput, controller.signal);

    expect(result).toEqual({ isError: true, content: CANCELLED_NOTHING_PUSHED });
    // The pre-card read only: the cancelled turn's record is never read a second time.
    expect(collectCalls).toHaveLength(1);
    expect(pushCalls).toHaveLength(0);
    expect(markCalls).toHaveLength(0);
  });

  test("reports the cancel, not the record refusal, when the turn is cancelled during the re-check", async () => {
    const controller = new AbortController();
    recordOnceThen(() => {
      controller.abort();
      return { ok: false, reason: "the run moved" };
    });

    const result = await send(handoffInput, controller.signal);

    expect(result).toEqual({ isError: true, content: CANCELLED_NOTHING_PUSHED });
    expect(collectCalls).toHaveLength(2);
    expect(pushCalls).toHaveLength(0);
    expect(markCalls).toHaveLength(0);
  });

  test("reports the cancel, not a filesystem error, when the interrupted re-read throws", async () => {
    const controller = new AbortController();
    _flowHandoffDeps.collectHandoffRecord = async (input) => {
      collectCalls.push(input);
      if (collectCalls.length === 1) return { ok: true, record, newestRunId: NEWEST_RUN_ID };
      controller.abort();
      throw new Error("ELOOP");
    };

    const result = await send(handoffInput, controller.signal);

    expect(result).toEqual({ isError: true, content: CANCELLED_NOTHING_PUSHED });
    expect(pushCalls).toHaveLength(0);
    expect(markCalls).toHaveLength(0);
  });
});

describe("nax-flow__send — nothing is marked when nothing was pushed", () => {
  test("returns the cancelled result for a turn cancelled after the card (AC-15)", async () => {
    const controller = new AbortController();
    reply = async () => {
      controller.abort();
      return "allow";
    };

    const result = await send(handoffInput, controller.signal);

    expect(result).toEqual({ isError: true, content: CANCELLED_NOTHING_PUSHED });
    expect(pushCalls).toHaveLength(0);
    expect(markCalls).toHaveLength(0);
  });

  test("returns the branch-changed result when the head moved while the card was open (AC-16)", async () => {
    _flowProviderDeps.headSha = async () => OTHER_SHA;

    const result = await send(handoffInput);

    expect(result).toEqual({ isError: true, content: BRANCH_CHANGED });
    expect(pushCalls).toHaveLength(0);
    expect(kodaCalls).toHaveLength(0);
    expect(markCalls).toHaveLength(0);
  });
});
