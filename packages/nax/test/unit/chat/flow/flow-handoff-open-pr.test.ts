/**
 * flow-handoff.ts — the open-PR check a handoff applies before the card and at the push boundary.
 *
 * A chat handoff pushes a branch with no PR and asks koda to own the feature from there. A branch
 * that already has an open PR is a feature someone else is publishing, so the send is refused: once
 * in preflight, before any card, and once inside the handoff lock at the push boundary, because a PR
 * can appear between the two — the approval window is as long as the user takes over it.
 *
 * The harness is `flow-handoff.test.ts`'s trimmed to what this check reads: the record, the mark and
 * the clock on `_flowHandoffDeps`, the repository, the push and the koda create on
 * `_flowProviderDeps`, and nothing on disk.
 */

import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
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
import type { ChainAdmission, ChatChains } from "@/chat/jobs";
import type { ChatChain } from "@/chat/jobs/chain-types";
import { NaxError } from "@/errors";
import { defaultForgeDeps } from "@/forge";
import type { HandoffRecordFile } from "@/workflow/handoff-record";

withDepsRestore(_flowProviderDeps);
withDepsRestore(_flowHandoffDeps);

/**
 * The real seam the default `_flowHandoffDeps.hasOpenPr` resolves through, captured before the
 * setup below replaces it. The delegation it makes — `hasOpenPr("github", branch, defaultForgeDeps,
 * repoRoot, repo)` — is asserted by stubbing `defaultForgeDeps.run` (AC-18).
 */
const defaultHasOpenPr = _flowHandoffDeps.hasOpenPr;

const REPO_ROOT = "/fixture/repo";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const BRANCH = "feat/x";
/** The push destination, as a repository with an SSH `origin` resolves it. */
const PUSH_URL = "git@github.com:o/r.git";
/**
 * The reference of the carded repository, as the check names it: host included, so neither `GH_REPO` nor
 * `GH_HOST` can make the CLI answer for a repository this handoff never touches.
 */
const REPO = "github.com/o/r";
/** The clock the mark's timestamp comes from. */
const AT = new Date("2026-11-18T09:30:00.000Z");
const FEATURE = "f1";
/** The newest run the collected record came from, which is the run the mark belongs to. */
const NEWEST_RUN_ID = "r2";
/** The GitHub argv an open-PR read issues for `BRANCH` in the carded repository. */
const PR_LIST_ARGV = ["gh", "pr", "list", "--head", BRANCH, "--state", "open", "--json", "number", "--repo", REPO];

const OPEN_PR_REFUSAL = `[chat] cannot hand off ${FEATURE}: branch ${BRANCH} already has an open PR; a handoff needs a branch with no PR`;

/** The refusal a forge that could not answer earns, with the error's own message in parentheses. */
function couldNotCheck(detail: string): string {
  return `[chat] cannot hand off ${FEATURE}: could not check branch ${BRANCH} for an open PR (${detail}); nothing was pushed`;
}

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

/** The request the brief uses: one already-run feature, the two roles and the cap. */
const handoffInput = {
  handoff: { feature: FEATURE },
  roles: { reviewer: "acp:codex", supervisor: "acp:claude" },
  costCapUsd: 5,
};

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
  readonly mark: Parameters<(typeof _flowHandoffDeps)["writeHandoffMark"]>[1];
}

interface OpenPrCall {
  readonly branch: string;
  readonly repo: string;
  readonly repoRoot: string;
}

let approveCalls: HostApprovalCard[];
let pushCalls: PushCall[];
let kodaCalls: KodaCall[];
let markCalls: MarkCall[];
let openPrCalls: OpenPrCall[];
/** The answers `hasOpenPr` gives, in order; the last one repeats once the list runs out. */
let openPrAnswers: (() => Promise<boolean>)[];
let options: FlowProviderOptions;

/** A repository state a handoff may push from. */
function ready(branch = BRANCH, sha = SHA, remoteUrl = "https://github.com/o/r"): FlowRepoReady {
  return { ok: true, branch, sha, remoteUrl };
}

/** The tool's run context. */
function context() {
  return { root: REPO_ROOT, resolvedPaths: [], maxBytes: 300_000, maxFileBytes: 300_000 };
}

/** Run the provider's `send` tool with `request`. */
async function send(request: Record<string, unknown> = handoffInput) {
  const tool = (await createFlowProvider(options).tools(REPO_ROOT))[0];
  assertDefined(tool, "the nax-flow provider's send tool");
  return await tool.run(request, context());
}

/** Nothing was transferred: no push, no koda create, no mark. */
function expectNoTransfer(): void {
  expect(pushCalls).toHaveLength(0);
  expect(kodaCalls).toHaveLength(0);
  expect(markCalls).toHaveLength(0);
}

beforeEach(() => {
  approveCalls = [];
  pushCalls = [];
  kodaCalls = [];
  markCalls = [];
  openPrCalls = [];
  openPrAnswers = [async () => false];
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
  _flowHandoffDeps.collectHandoffRecord = async () => ({
    ok: true,
    record,
    newestRunId: NEWEST_RUN_ID,
    results: [],
  });
  _flowHandoffDeps.readNewestHandoffMark = async () => null;
  _flowHandoffDeps.readRunMark = async () => null;
  _flowHandoffDeps.handoffResultsMatch = async () => true;
  _flowHandoffDeps.writeHandoffMark = async (runDir, mark) => {
    markCalls.push({ runDir, mark });
  };
  _flowHandoffDeps.withFileLock = async (_path, operation, { signal }) => {
    signal?.throwIfAborted();
    return operation();
  };
  _flowHandoffDeps.hasOpenPr = async (branch, repo, repoRoot) => {
    openPrCalls.push({ branch, repo, repoRoot });
    const next = openPrAnswers.length > 1 ? openPrAnswers.shift() : openPrAnswers[0];
    return next === undefined ? false : await next();
  };
  _flowHandoffDeps.now = () => AT;
  options = {
    repoRoot: REPO_ROOT,
    connection,
    approve: async (card) => {
      approveCalls.push(card);
      return "allow";
    },
  };
});

/** A chain whose next step is this feature's handoff, as `flow-handoff.test.ts` observes one. */
function observeChain(chain: ChatChain) {
  const admission: ChainAdmission = { kind: "auto", chainId: chain.id, step: 2, approvedAt: AT.toISOString() };
  const admit = mock<ChatChains["admit"]>(() => admission);
  const stepEnded = mock(() => {});
  const stop = mock(() => undefined);
  const chains = {
    admit,
    stepEnded,
    stop,
    active: () => chain,
    summary: () => ({
      ...chain,
      next: 2,
      spent: 0,
      steps: chain.steps.map((step, i) => ({ ...step, step: i + 1 })),
    }),
    activate: async () => {
      throw new Error("unexpected activation");
    },
    started: () => {},
    startFailed: () => {},
    isActive: () => true,
    recordCheck: () => ({ ok: true }),
    dispose: () => {},
  } satisfies ChatChains;
  options = { ...options, chains };
  return { admit, stepEnded, stop };
}

const ACTIVE: ChatChain = {
  schemaVersion: 1,
  id: "chain-12345678",
  sessionId: "chat-1",
  cwd: REPO_ROOT,
  approvedAt: AT.toISOString(),
  state: "active",
  steps: [
    { kind: "run", argv: [], target: FEATURE },
    { kind: "handoff", argv: [], target: FEATURE },
  ],
};

describe("nax-flow__send — the open-PR check before the card", () => {
  test("refuses a branch that already has an open PR with the exact refusal text (AC-1)", async () => {
    openPrAnswers = [async () => true];

    const result = await send();

    expect(result).toEqual({ isError: true, content: OPEN_PR_REFUSAL });
  });

  test("never asks for approval, pushes or creates a flow for an open PR (AC-2, AC-3, AC-4)", async () => {
    openPrAnswers = [async () => true];

    await send();

    expect(approveCalls).toHaveLength(0);
    expectNoTransfer();
  });

  test("checks the checked-out branch in the carded repository at the chat's repository root (AC-5)", async () => {
    _flowProviderDeps.readFlowRepoState = async () => ready("feat/handoff");

    await send();

    // Once before the card, with the branch the repository read reported...
    expect(openPrCalls[0]).toEqual({ branch: "feat/handoff", repo: REPO, repoRoot: REPO_ROOT });
    // ...and once more at the push boundary under the handoff lock.
    expect(openPrCalls).toHaveLength(2);
    expect(openPrCalls.every((call) => call.branch === "feat/handoff")).toBe(true);
    expect(openPrCalls.every((call) => call.repo === REPO)).toBe(true);
    expect(openPrCalls.every((call) => call.repoRoot === REPO_ROOT)).toBe(true);
  });

  test("reports the forge's own failure with the could-not-check refusal (AC-6)", async () => {
    const failure = "hasOpenPr: forge CLI exited with code 1: gh: not logged in";
    openPrAnswers = [
      async () => {
        throw new NaxError(failure, "FORGE_PR_LIST_FAILED", { forge: "github", branch: BRANCH, exitCode: 1 });
      },
    ];

    const result = await send();

    expect(result.isError).toBe(true);
    expect(
      result.content.startsWith(`[chat] cannot hand off ${FEATURE}: could not check branch ${BRANCH} for an open`),
    ).toBe(true);
    expect(result.content).toContain(failure);
  });

  test("refuses an unexpected forge failure in preflight and pushes nothing (AC-7, AC-8, AC-9)", async () => {
    openPrAnswers = [
      async () => {
        throw new Error("spawn gh ENOENT");
      },
    ];

    const result = await send();

    expect(result).toEqual({ isError: true, content: couldNotCheck("spawn gh ENOENT") });
    expect(approveCalls).toHaveLength(0);
    expectNoTransfer();
  });

  test("refuses an unexpected forge failure under the handoff lock and pushes nothing (AC-7, AC-8, AC-9)", async () => {
    openPrAnswers = [
      async () => false,
      async () => {
        throw new Error("cannot parse the open PR list");
      },
    ];

    const result = await send();

    expect(result).toEqual({ isError: true, content: couldNotCheck("cannot parse the open PR list") });
    // The card was shown — the failure is the guard's, not preflight's — and nothing left the machine.
    expect(approveCalls).toHaveLength(1);
    expectNoTransfer();
  });
});

describe("nax-flow__send — the open-PR check at the push boundary", () => {
  test("refuses an open PR that appeared after approval, before the push (AC-10, AC-11, AC-12, AC-13)", async () => {
    openPrAnswers = [async () => false, async () => true];

    const result = await send();

    expect(approveCalls).toHaveLength(1);
    expect(result).toEqual({ isError: true, content: OPEN_PR_REFUSAL });
    expectNoTransfer();
  });

  test("returns the could-not-check refusal ending in `; nothing was pushed` when the guard's check rejects (AC-14)", async () => {
    openPrAnswers = [
      async () => false,
      async () => {
        throw new NaxError("hasOpenPr: forge CLI exited with code 1: HTTP 503", "FORGE_PR_LIST_FAILED", {
          forge: "github",
          branch: BRANCH,
          exitCode: 1,
        });
      },
    ];

    const result = await send();

    expect(result).toEqual({
      isError: true,
      content: couldNotCheck("hasOpenPr: forge CLI exited with code 1: HTTP 503"),
    });
    expect(result.content.endsWith("; nothing was pushed")).toBe(true);
    expectNoTransfer();
  });

  test("never calls handoffResultsMatch when the post-approval check reports an open PR (AC-21)", async () => {
    const resultsMatch = mock(async () => true);
    _flowHandoffDeps.handoffResultsMatch = resultsMatch;
    openPrAnswers = [async () => false, async () => true];

    await send();

    expect(resultsMatch).not.toHaveBeenCalled();
  });

  test("pushes and creates the flow when neither check reports a PR (AC-15, AC-16)", async () => {
    const openPr = mock(async () => false);
    _flowHandoffDeps.hasOpenPr = openPr;

    const result = await send();

    expect(openPr).toHaveBeenCalledTimes(2);
    expect(result.isError).toBeUndefined();
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0]?.branch).toBe(BRANCH);
    expect(kodaCalls).toHaveLength(1);
    expect(markCalls).toHaveLength(1);
  });
});

describe("nax-flow__send — an open PR in a chain", () => {
  test("stops the chain whose next step is this feature's handoff, with the refusal as the stop reason (AC-17)", async () => {
    const { admit, stepEnded, stop } = observeChain(ACTIVE);
    openPrAnswers = [async () => true];

    const result = await send();

    expect(result).toEqual({ isError: true, content: OPEN_PR_REFUSAL });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith(OPEN_PR_REFUSAL.replace(/^\[chat\] /, ""));
    expect(admit).not.toHaveBeenCalled();
    expect(stepEnded).not.toHaveBeenCalled();
    expectNoTransfer();
  });
});

describe("nax-flow__send — the default open-PR seam", () => {
  test("delegates to the forge's `hasOpenPr` naming the carded repository (AC-18)", async () => {
    _flowHandoffDeps.hasOpenPr = defaultHasOpenPr;
    const run = spyOn(defaultForgeDeps, "run").mockResolvedValue({ exitCode: 0, stdout: "[]", stderr: "" });
    try {
      await send();

      // The stub on `defaultForgeDeps` is what the default seam reaches, so this is the delegation.
      expect(run).toHaveBeenCalled();
      expect(run.mock.calls[0]?.[0]).toEqual(PR_LIST_ARGV);
      expect(run.mock.calls[0]?.[1]).toEqual({ cwd: REPO_ROOT });
    } finally {
      // mockRestore drops the recorded calls, so every assertion is made before it runs.
      run.mockRestore();
    }
  });

  test("asks about the carded repository even when the CLI's own default names another one (B4)", async () => {
    // `gh` reads `GH_REPO` before it discovers a repository from the working directory, so a checkout
    // whose CLI default differs from the verified push destination could answer for a repository this
    // handoff never touches — an empty list there would authorize the push. The argv must name the
    // carded repository explicitly, which outranks `GH_REPO`.
    const before = process.env.GH_REPO;
    process.env.GH_REPO = "someone-else/other";
    _flowHandoffDeps.hasOpenPr = defaultHasOpenPr;
    const run = spyOn(defaultForgeDeps, "run").mockResolvedValue({ exitCode: 0, stdout: "[]", stderr: "" });
    try {
      await send();

      const argv = run.mock.calls[0]?.[0] ?? [];
      expect(argv).toEqual(PR_LIST_ARGV);
      expect(argv).toContain("--repo");
      expect(argv[argv.indexOf("--repo") + 1]).toBe(REPO);
    } finally {
      run.mockRestore();
      if (before === undefined) delete process.env.GH_REPO;
      else process.env.GH_REPO = before;
    }
  });

  test("names the push destination's host even when GH_HOST points the CLI at another one (B4)", async () => {
    // `gh` takes its host from `--repo` only when the reference carries one; a bare `owner/repo` is looked
    // up on `GH_HOST` when that variable is set. A conflicting host would then answer for a repository of
    // the same name that is not the push destination, so the reference must spell github.com out.
    const before = process.env.GH_HOST;
    process.env.GH_HOST = "ghe.internal.example";
    _flowHandoffDeps.hasOpenPr = defaultHasOpenPr;
    const run = spyOn(defaultForgeDeps, "run").mockResolvedValue({ exitCode: 0, stdout: "[]", stderr: "" });
    try {
      await send();

      const argv = run.mock.calls[0]?.[0] ?? [];
      expect(argv).toEqual(PR_LIST_ARGV);
      expect(argv[argv.indexOf("--repo") + 1]).toBe("github.com/o/r");
    } finally {
      run.mockRestore();
      if (before === undefined) delete process.env.GH_HOST;
      else process.env.GH_HOST = before;
    }
  });
});

describe("nax-flow__send — a run that was already handed off", () => {
  test("returns the existing mark refusal without checking the forge (AC-19, AC-20)", async () => {
    _flowHandoffDeps.readNewestHandoffMark = async () => ({
      mark: { schemaVersion: 1, at: "T", flowId: "fl9", url: "https://koda/flows/fl9" },
      path: "/r/handoff.json",
    });
    openPrAnswers = [async () => true];

    const result = await send();

    expect(result.isError).toBe(true);
    expect(result.content.startsWith("[chat] f1 was handed off to koda (flow fl9")).toBe(true);
    expect(result.content).toContain("/r/handoff.json");
    expect(openPrCalls).toHaveLength(0);
    expect(approveCalls).toHaveLength(0);
    expectNoTransfer();
  });
});
