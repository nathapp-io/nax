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

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import { _fileLockDeps } from "@nathapp/nax-agent/internal";
import { assertDefined, cleanupTempDir, makeTempDir, withDepsRestore } from "@test/helpers";
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
import { type HandoffMark, readNewestHandoffMark } from "@/workflow/handoff-mark";
import { _handoffRecordDeps, collectHandoffRecord, type HandoffRecordFile } from "@/workflow/handoff-record";
import { workflowFeatureDir, workflowRunDir } from "@/workflow/paths";

withDepsRestore(_flowProviderDeps);
withDepsRestore(_flowHandoffDeps);
withDepsRestore(_fileLockDeps);
withDepsRestore(_handoffRecordDeps);

let repoRoot: string;
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
const FINISHED_RESULT = JSON.stringify({
  schemaVersion: 1,
  featureWorkflow: { step: "done", outcome: "local-only", head: SHA },
});

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
    root: repoRoot,
    resolvedPaths: [],
    maxBytes: 300_000,
    maxFileBytes: 300_000,
    ...(signal ? { signal } : {}),
  };
}

/** Run the provider's `send` tool with `request`. */
async function send(request: Record<string, unknown>, signal?: AbortSignal) {
  const tool = (await createFlowProvider(options).tools(repoRoot))[0];
  assertDefined(tool, "the nax-flow provider's send tool");
  return await tool.run(request, context(signal));
}

beforeEach(async () => {
  repoRoot = makeTempDir("nax-handoff-recheck-");
  const runDir = workflowRunDir(repoRoot, FEATURE, NEWEST_RUN_ID);
  await mkdir(runDir, { recursive: true });
  await Bun.write(join(runDir, "result.json"), FINISHED_RESULT);
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
    repoRoot,
    connection,
    approve: async (card) => {
      approveCalls.push(card);
      return await reply(card);
    },
  };
});

afterEach(() => cleanupTempDir(repoRoot));

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

  test("refuses a result that appears during post-approval collection, without transferring or marking", async () => {
    const older = join(workflowRunDir(repoRoot, FEATURE, NEWEST_RUN_ID), "result.json");
    const newRunDir = workflowRunDir(repoRoot, FEATURE, "r3");
    const newer = join(newRunDir, "result.json");
    await mkdir(newRunDir);
    await utimes(older, 1, 1);
    _handoffRecordDeps.git = async () => ({
      stdout: JSON.stringify({ branchName: BRANCH, userStories: [] }),
      stderr: "",
      exitCode: 0,
    });
    _flowHandoffDeps.collectHandoffRecord = collectHandoffRecord;
    allowAfter(() => {
      const open = _handoffRecordDeps.open;
      _handoffRecordDeps.open = async (path, flags, mode) => {
        if (path === older) {
          // The listing has already omitted r3; the listed result itself will not change.
          await Bun.write(newer, FINISHED_RESULT);
          await utimes(newer, 2, 2);
        }
        return open(path, flags, mode);
      };
    });

    const result = await send(handoffInput);

    expect(approveCalls).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("workflow results changed during collection");
    expectNoTransfer();
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
    expect(result.content).toContain(`${workflowRunDir(repoRoot, FEATURE, NEWEST_RUN_ID)}/handoff.json`);
    expect(pushCalls).toHaveLength(0);
    expect(kodaCalls).toHaveLength(0);
    expect(markCalls).toHaveLength(0);
  });
});

/** Run a real approved handoff in a separate Bun process, paused inside its mark writer. */
async function withOtherPublisher(
  assertWhileHeld: (holder: {
    readonly lockPath: string;
    readonly pid: number;
    readonly contended: Promise<void>;
    readonly finish: () => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const lockPath = join(workflowFeatureDir(repoRoot, FEATURE), ".handoff.lock");
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
      import { _flowHandoffDeps, _flowProviderDeps } from "@/chat/flow";
      import { sendFlowHandoff } from "@/chat/flow/flow-handoff";
      import { _handoffRecordDeps } from "@/workflow/handoff-record";
      const { repoRoot, state, pushUrl, request, connection } = JSON.parse(process.argv[1]);
      _flowProviderDeps.readFlowRepoState = async () => state;
      _flowProviderDeps.readFlowPushUrl = async () => ({ ok: true, url: pushUrl });
      _flowProviderDeps.headSha = async () => state.sha;
      _flowProviderDeps.isDirty = async () => false;
      _flowProviderDeps.commitAndPush = async () => ({ committed: false, pushed: true });
      _flowProviderDeps.createKodaFlow = async () => ({ kind: "held", requestId: "held-by-child" });
      _handoffRecordDeps.git = async () => ({
        stdout: JSON.stringify({ branchName: state.branch, userStories: [] }), stderr: "", exitCode: 0,
      });
      const write = _flowHandoffDeps.writeHandoffMark;
      _flowHandoffDeps.writeHandoffMark = async (runDir, mark) => {
        console.log("ready");
        await new Response(Bun.stdin.stream()).text();
        await write(runDir, mark);
      };
      const result = await sendFlowHandoff(request, undefined, { repoRoot, connection, approve: async () => "allow" });
      if (result.isError) throw new Error(result.content);
    `,
      JSON.stringify({ repoRoot, state: ready(), pushUrl: PUSH_URL, request: handoffInput, connection }),
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
  );
  let released = false;
  const finish = async () => {
    if (!released) {
      released = true;
      child.stdin.end();
    }
    expect(await child.exited).toBe(0);
  };
  const contended = Promise.withResolvers<void>();
  const sleep = _fileLockDeps.sleep;
  _fileLockDeps.sleep = (ms, signal) => {
    const retry = sleep(ms, signal);
    contended.resolve(); // An exclusive create failed and the waiter is now in backoff.
    return retry;
  };
  _flowHandoffDeps.readNewestHandoffMark = readNewestHandoffMark;
  try {
    const stdout = child.stdout.getReader();
    const { value } = await stdout.read();
    stdout.releaseLock();
    expect(new TextDecoder().decode(value).trim()).toBe("ready");
    await assertWhileHeld({ lockPath, pid: child.pid, contended: contended.promise, finish });
  } finally {
    await finish();
  }
}

function waitingOrFinished(contended: Promise<void>, sendResult: Promise<unknown>) {
  return Promise.race([contended.then(() => "waiting"), sendResult.then(() => "finished")]);
}

function expectNoTransfer(): void {
  expect(pushCalls).toHaveLength(0);
  expect(kodaCalls).toHaveLength(0);
  expect(markCalls).toHaveLength(0);
}

describe("nax-flow__send — cross-process handoff lock", () => {
  test("an approved send waits for the other publisher's mark before rechecking", async () => {
    await withOtherPublisher(async ({ contended, finish }) => {
      const pending = send(handoffInput);
      const beforeMark = await waitingOrFinished(contended, pending);
      const collectionsBeforeMark = collectCalls.length;
      await finish();
      const result = await pending;

      expect(beforeMark).toBe("waiting");
      expect(collectionsBeforeMark).toBe(1); // Only preflight has run.
      expect(result.isError).toBe(true);
      expect(result.content).toContain("was handed off to koda (approval request held-by-child)");
      expectNoTransfer();
    });
  });

  test("a cancelled waiter returns while the other process still holds the lock", async () => {
    await withOtherPublisher(async ({ lockPath, pid, contended }) => {
      const controller = new AbortController();
      const pending = send(handoffInput, controller.signal);
      expect(await waitingOrFinished(contended, pending)).toBe("waiting");
      controller.abort();

      expect(await pending).toEqual({ isError: true, content: CANCELLED_NOTHING_PUSHED });
      expect(await Bun.file(lockPath).text()).toBe(`${pid}\n`);
      expect(collectCalls).toHaveLength(1);
      expectNoTransfer();
    });
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

  test("skips the push-boundary mark check if cancelled during Git verification", async () => {
    const controller = new AbortController();
    _flowProviderDeps.readFlowPushUrl = async () => {
      controller.abort();
      return { ok: true, url: PUSH_URL };
    };
    const readMark = mock(async () => null);
    _flowHandoffDeps.readRunMark = readMark;

    expect(await send(handoffInput, controller.signal)).toEqual({ isError: true, content: CANCELLED_NOTHING_PUSHED });
    expect(readMark).not.toHaveBeenCalled();
    expectNoTransfer();
  });

  test.each([true, false])("a rejecting mark check preserves cancellation only if aborted (%s)", async (aborted) => {
    const controller = new AbortController();
    _flowHandoffDeps.readRunMark = async () => {
      if (aborted) controller.abort();
      throw new Error("could not read the run mark");
    };

    const result = await send(handoffInput, controller.signal);

    expect(result).toEqual({
      isError: true,
      content: aborted ? CANCELLED_NOTHING_PUSHED : "[chat] flow send failed: could not read the run mark",
    });
    expectNoTransfer();
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
