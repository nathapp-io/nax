/**
 * flow-handoff.ts — the approved handoff replays deferred result recoveries under its own lock (#2984).
 *
 * A run-end or crash repair that cannot take the feature's handoff lock keeps a damaged `result.json`'s
 * good copy in `result.recovery.json` instead of waiting. The handoff holds that same lock from its
 * post-approval recheck through the mark write, so its lock-take is where a kept copy is replayed — and
 * it must be, or the recheck would compare against a record that is missing or damaged on disk.
 *
 * The harness is the one `flow-handoff-recheck.test.ts` drives: the record, the mark and the clock on
 * `_flowHandoffDeps`, the repository, the push and the koda create on `_flowProviderDeps`. The recovery
 * module is the real one, except where a case counts its calls.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "@nathapp/nax-agent/internal";
import { assertDefined, cleanupTempDir, makeTempDir, withDepsRestore } from "@test/helpers";
import type { HostApprovalCard } from "@/chat/ask-controller";
import {
  _flowHandoffDeps,
  _flowProviderDeps,
  createFlowProvider,
  type FlowProviderOptions,
  type FlowRepoReady,
  type KodaFlowConnection,
} from "@/chat/flow";
import { _handoffRecordDeps, collectHandoffRecord, type HandoffRecordFile } from "@/workflow/handoff-record";
import { workflowFeatureDir, workflowRunDir } from "@/workflow/paths";
import { type ResultRecovery, writeResultRecovery } from "@/workflow/result-recovery";

withDepsRestore(_flowProviderDeps);
withDepsRestore(_flowHandoffDeps);
withDepsRestore(_handoffRecordDeps);

const FEATURE = "f1";
const NEWEST_RUN_ID = "r2";
const OLDER_RUN_ID = "r1";
const BRANCH = "feat/x";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const PUSH_URL = "git@github.com:o/r.git";
const AT = new Date("2026-11-18T09:30:00.000Z");
const RECORD_CHANGED = "[chat] the run record changed while the card was open; nothing was pushed";
const REL = `.nax/features/${FEATURE}/workflow/${NEWEST_RUN_ID}/result.json`;

/** What the run left on disk: a finished feature record that ended without a PR at the pushed HEAD. */
const FINISHED_RESULT = JSON.stringify({
  schemaVersion: 1,
  featureWorkflow: { step: "done", outcome: "local-only", head: SHA },
});
/** The kept copy a deferral wrote: the same outcome, with the story records the agent had dropped. */
const RECOVERED_RESULT = JSON.stringify({
  schemaVersion: 1,
  featureWorkflow: { step: "done", outcome: "local-only", head: SHA },
  stories: {},
});

const connection: KodaFlowConnection = {
  url: "https://koda.example/api",
  headers: { Authorization: "Bearer k" },
};

/** The record the card approved, as the stubbed collector reports it. */
const record: readonly HandoffRecordFile[] = [
  { runId: NEWEST_RUN_ID, file: "result.json", mtimeMs: 2, content: FINISHED_RESULT },
  { runId: OLDER_RUN_ID, file: "result.json", mtimeMs: 1, content: FINISHED_RESULT },
];

const handoffInput = {
  handoff: { feature: FEATURE },
  roles: { reviewer: "acp:codex", supervisor: "acp:claude" },
  costCapUsd: 5,
};

interface PushCall {
  readonly branch: string;
}

interface KodaCall {
  readonly body: unknown;
}

let repoRoot: string;
let approveCalls: HostApprovalCard[];
/** What the host answers the card with; a case replaces it to change the disk before the allow. */
let reply: (card: HostApprovalCard) => Promise<"allow" | "deny">;
let pushCalls: PushCall[];
let kodaCalls: KodaCall[];
let markCalls: string[];
let collectCalls: { readonly feature: string }[];
let options: FlowProviderOptions;

/** A repository state a handoff may push from. */
function ready(): FlowRepoReady {
  return { ok: true, branch: BRANCH, sha: SHA, remoteUrl: "https://github.com/o/r" };
}

function context() {
  return { root: repoRoot, resolvedPaths: [], maxBytes: 300_000, maxFileBytes: 300_000 };
}

/** Run the provider's `send` tool with the handoff request. */
async function send() {
  const tool = (await createFlowProvider(options).tools(repoRoot))[0];
  assertDefined(tool, "the nax-flow provider's send tool");
  return await tool.run(handoffInput, context());
}

function resultPathOf(runId: string): string {
  return join(workflowRunDir(repoRoot, FEATURE, runId), "result.json");
}

function recoveryPathOf(runId: string): string {
  return join(workflowRunDir(repoRoot, FEATURE, runId), "result.recovery.json");
}

/** The kept copy a run-end repair would have written for a missing result. */
function missingRecovery(content: string): ResultRecovery {
  return { schemaVersion: 1, rel: REL, damaged: { kind: "missing" }, content };
}

function expectNoTransfer(): void {
  expect(pushCalls).toHaveLength(0);
  expect(kodaCalls).toHaveLength(0);
  expect(markCalls).toHaveLength(0);
}

/** One run directory holding a result.json, with the mtime the record's ordering uses. */
async function seedRun(runId: string, mtimeMs: number): Promise<void> {
  const runDir = workflowRunDir(repoRoot, FEATURE, runId);
  await mkdir(runDir, { recursive: true });
  await Bun.write(join(runDir, "result.json"), FINISHED_RESULT);
  await utimes(join(runDir, "result.json"), mtimeMs, mtimeMs);
}

beforeEach(async () => {
  repoRoot = makeTempDir("nax-handoff-recovery-");
  await seedRun(OLDER_RUN_ID, 1);
  await seedRun(NEWEST_RUN_ID, 2);
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
  _flowProviderDeps.commitAndPush = async (_root, branch) => {
    pushCalls.push({ branch });
    return { committed: false, pushed: true };
  };
  _flowProviderDeps.createKodaFlow = async (_connection, body) => {
    kodaCalls.push({ body });
    return { kind: "created", id: "fl1", state: "PENDING", url: "/flows/fl1" };
  };
  _flowHandoffDeps.collectHandoffRecord = async (input) => {
    collectCalls.push({ feature: input.feature });
    return { ok: true, record, newestRunId: NEWEST_RUN_ID, results: [] };
  };
  _flowHandoffDeps.readNewestHandoffMark = async () => null;
  _flowHandoffDeps.readRunMark = async () => null;
  _flowHandoffDeps.handoffResultsMatch = async () => true;
  _flowHandoffDeps.writeHandoffMark = async (runDir) => {
    markCalls.push(runDir);
  };
  // The default seam would ask the real forge about the fixture repository and refuse every send.
  _flowHandoffDeps.hasOpenPr = async () => false;
  _flowHandoffDeps.now = () => AT;
  // The committed PRD the record preflight reads at HEAD: it names the pushed branch and is complete.
  _handoffRecordDeps.git = async () => ({
    stdout: JSON.stringify({ branchName: BRANCH, userStories: [] }),
    stderr: "",
    exitCode: 0,
  });
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

describe("nax-flow__send — a deferred result is replayed under the handoff lock", () => {
  test("an approved handoff replays pending recoveries before the post-approval record read (AC-14)", async () => {
    const restoreCalls: { readonly dir: string; readonly holding: boolean; readonly collections: number }[] = [];
    let holding = false;
    _flowHandoffDeps.withFileLock = async (lockPath, operation, lockOptions) => {
      holding = true;
      try {
        return await withFileLock(lockPath, operation, lockOptions);
      } finally {
        holding = false;
      }
    };
    _flowHandoffDeps.restorePendingResults = async (workflowDir) => {
      restoreCalls.push({ dir: workflowDir, holding, collections: collectCalls.length });
      return [];
    };

    await send();

    // Once, inside the lock, before the recheck re-reads the record: the carded record is the one
    // preflight collected, so a restore that ran earlier would be pointless and one that ran later
    // too late.
    expect(restoreCalls).toEqual([{ dir: workflowFeatureDir(repoRoot, FEATURE), holding: true, collections: 1 }]);
  });

  test("an approved handoff restores a result its deferral kept (AC-15)", async () => {
    const resultPath = resultPathOf(NEWEST_RUN_ID);
    reply = async () => {
      await rm(resultPath);
      await writeResultRecovery(resultPath, missingRecovery(RECOVERED_RESULT));
      return "allow";
    };

    const result = await send();

    expect(await Bun.file(resultPath).text()).toBe(RECOVERED_RESULT);
    expect(await Bun.file(recoveryPathOf(NEWEST_RUN_ID)).exists()).toBe(false);
    // The record it restored is the one the card approved, so the send goes on.
    expect(result.isError).toBeFalsy();
    expect(pushCalls).toHaveLength(1);
  });

  test("a restored record that differs from the carded one stops the send (AC-16)", async () => {
    // The real collector, so the recheck reads the record the restore left on disk.
    _flowHandoffDeps.collectHandoffRecord = async (input) => {
      collectCalls.push({ feature: input.feature });
      return await collectHandoffRecord(input);
    };
    const resultPath = resultPathOf(NEWEST_RUN_ID);
    reply = async () => {
      await rm(resultPath);
      await writeResultRecovery(resultPath, missingRecovery(RECOVERED_RESULT));
      return "allow";
    };

    const result = await send();

    // The real recheck read the restored record, which is not the one the user approved.
    expect(result).toEqual({ isError: true, content: RECORD_CHANGED });
    expect(await Bun.file(resultPath).text()).toBe(RECOVERED_RESULT);
    expect(collectCalls).toHaveLength(2);
    expectNoTransfer();
  });
});
